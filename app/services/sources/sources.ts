import * as fs from 'fs';
import Vue from 'vue';
import { Subject } from 'rxjs/Subject';
import { IObsListOption, setupConfigurableDefaults, TObsValue } from 'components/obs/inputs/ObsInput';
import { StatefulService, mutation } from 'services/stateful-service';
import * as obs from '../../../obs-api';
import electron from 'electron';
import { Inject } from 'util/injector';
import namingHelpers from 'util/NamingHelpers';
import { WindowsService } from 'services/windows';
import { WidgetsService, WidgetType, WidgetDisplayData } from 'services/widgets';
import { DefaultManager } from './properties-managers/default-manager';
import { WidgetManager } from './properties-managers/widget-manager';
import { ScenesService, ISceneItem } from 'services/scenes';
import { StreamlabelsManager } from './properties-managers/streamlabels-manager';
import { PlatformAppManager } from './properties-managers/platform-app-manager';
import { UserService } from 'services/user';
import {
  IActivePropertyManager, ISource, ISourceCreateOptions, ISourcesServiceApi, ISourcesState,
  TSourceType,
  Source,
  TPropertiesManager,
  ISourceAddOptions
} from './index';
import uuid from 'uuid/v4';
import { $t } from 'services/i18n';
import { SourceDisplayData } from './sources-data';
import { NavigationService } from 'services/navigation';
import { PlatformAppsService } from 'services/platform-apps';


const SOURCES_UPDATE_INTERVAL = 1000;

const { ipcRenderer } = electron;

const AudioFlag = obs.ESourceOutputFlags.Audio;
const VideoFlag = obs.ESourceOutputFlags.Video;
const AsyncFlag = obs.ESourceOutputFlags.Async;
const DoNotDuplicateFlag = obs.ESourceOutputFlags.DoNotDuplicate;

export const PROPERTIES_MANAGER_TYPES = {
  default: DefaultManager,
  widget: WidgetManager,
  streamlabels: StreamlabelsManager,
  platformApp: PlatformAppManager
};

export class SourcesService extends StatefulService<ISourcesState> implements ISourcesServiceApi {

  static initialState = {
    sources: {},
    temporarySources: {} // don't save temporarySources in the config file
  } as ISourcesState;

  sourceAdded = new Subject<ISource>();
  sourceUpdated = new Subject<ISource>();
  sourceRemoved = new Subject<ISource>();

  @Inject() private scenesService: ScenesService;
  @Inject() private windowsService: WindowsService;
  @Inject() private widgetsService: WidgetsService;
  @Inject() private userService: UserService;
  @Inject() private navigationService: NavigationService;
  @Inject() private platformAppsService: PlatformAppsService;

  /**
   * Maps a source id to a property manager
   */
  propertiesManagers: Dictionary<IActivePropertyManager> = {};


  protected init() {
    setInterval(() => this.requestSourceSizes(), SOURCES_UPDATE_INTERVAL);

    this.scenesService.itemRemoved.subscribe(
      (sceneSourceModel) => this.onSceneItemRemovedHandler(sceneSourceModel)
    );

    this.scenesService.sceneRemoved.subscribe(
      (sceneModel) => this.removeSource(sceneModel.id)
    );
  }

  @mutation()
  private RESET_SOURCES() {
    this.state.sources = {};
  }

  @mutation()
  private ADD_SOURCE(id: string, name: string, type: TSourceType, channel?: number, isTemporary?: boolean) {
    const sourceModel: ISource = {
      sourceId: id,
      name,
      type,

      // Whether the source has audio and/or video
      // Will be updated periodically
      audio: false,
      video: false,
      async: false,
      doNotDuplicate: false,

      // Unscaled width and height
      width: 0,
      height: 0,

      muted: false,
      resourceId: 'Source' + JSON.stringify([id]),
      channel
    };

    if (isTemporary) {
      Vue.set(this.state.temporarySources, id, sourceModel);
    } else {
      Vue.set(this.state.sources, id, sourceModel);
    }
  }

  @mutation()
  private REMOVE_SOURCE(id: string) {
    Vue.delete(this.state.sources, id);
  }

  @mutation()
  private UPDATE_SOURCE(sourcePatch: TPatch<ISource>) {
    Object.assign(this.state.sources[sourcePatch.id], sourcePatch);
  }


  createSource(
    name: string,
    type: TSourceType,
    settings: Dictionary<any> = {},
    options: ISourceCreateOptions = {}
  ): Source {

    const id: string = options.sourceId || `${type}_${uuid()}`;
    //called if the source chosen is browser source. allows us to default the url to our decklink
    //$AdLayer
    if (type === 'browser_source') {
      if (settings.shutdown === void 0) settings.shutdown = true;
      if (settings.url === void 0) settings.url = 'http://192.168.168.200:3000/search/lester';
    }

    if (type === 'text_gdiplus') {
      if (settings.text === void 0) settings.text = name;
    }

    const obsInput = obs.InputFactory.create(type, id, settings);

    this.addSource(obsInput, name, options);

    return this.getSource(id);
  }

  addSource(obsInput: obs.IInput, name: string, options: ISourceCreateOptions = {}) {
    if (options.channel !== void 0) {
      obs.Global.setOutputSource(options.channel, obsInput);
    }
    const id = obsInput.name;
    const type: TSourceType = obsInput.id as TSourceType;
    this.ADD_SOURCE(id, name, type, options.channel, options.isTemporary);
    const source = this.getSource(id);
    const muted = obsInput.muted;
    this.UPDATE_SOURCE({ id, muted });
    this.updateSourceFlags(source.sourceState, obsInput.outputFlags, true);

    const managerType = options.propertiesManager || 'default';
    const managerKlass = PROPERTIES_MANAGER_TYPES[managerType];
    this.propertiesManagers[id] = {
      manager: new managerKlass(obsInput, options.propertiesManagerSettings),
      type: managerType
    };

    if (source.hasProps()) setupConfigurableDefaults(obsInput);
    this.sourceAdded.next(source.sourceState);
  }

  removeSource(id: string) {
    const source = this.getSource(id);

    if (!source) throw  new Error(`Source ${id} not found`);

    /* When we release sources, we need to make
     * sure we reset the channel it's set to,
     * otherwise OBS thinks it's still attached
     * and won't release it. */
    if (source.channel !== void 0) {
      obs.Global.setOutputSource(source.channel, null);
    }

    this.REMOVE_SOURCE(id);
    this.propertiesManagers[id].manager.destroy();
    delete this.propertiesManagers[id];
    this.sourceRemoved.next(source.sourceState);
    source.getObsInput().release();
  }

  addFile(path: string): Source {
    const SUPPORTED_EXT = {
      image_source: ['png', 'jpg', 'jpeg', 'tga', 'bmp'],
      ffmpeg_source: ['mp4', 'ts', 'mov', 'flv', 'mkv', 'avi', 'mp3', 'ogg', 'aac', 'wav', 'gif', 'webm'],
      browser_source: ['html'],
      ad_layer: ['html'],
      text_gdiplus: ['txt']
    };
    let ext = path.split('.').splice(-1)[0];
    if (!ext) return null;
    ext = ext.toLowerCase();
    const filename = path.split('\\').splice(-1)[0];

    const types = Object.keys(SUPPORTED_EXT);
    for (const type of types) {
      if (!SUPPORTED_EXT[type].includes(ext)) continue;
      let settings: Dictionary<TObsValue>;
      if (type === 'image_source') {
        settings = { file: path };
      } else if (type === 'browser_source') {
        settings = {
          is_local_file: true,
          local_file: path
        };
      }else if (type === 'ad_layer') {
        settings = {
          is_local_file: true,
          local_file: path
        };
      }else if (type === 'ffmpeg_source') {
        settings = {
          is_local_file: true,
          local_file: path,
          looping: true
        };
      } else if (type === 'text_gdiplus') {
        settings = { text: fs.readFileSync(path).toString() };
      }
      return this.createSource(filename, type as TSourceType, settings);
    }
    return null;
  }

  suggestName(name: string): string {
    return namingHelpers.suggestName(name, (name: string) => this.getSourcesByName(name).length);
  }

  private onSceneItemRemovedHandler(sceneItemState: ISceneItem) {
    // remove source if it has been removed from the all scenes
    const source = this.getSource(sceneItemState.sourceId);

    if (source.type === 'scene') return;

    if (this.scenesService.getSourceScenes(source.sourceId).length > 0) return;
    this.removeSource(source.sourceId);
  }


  getAvailableSourcesTypesList(): IObsListOption<TSourceType>[] {
    const obsAvailableTypes = obs.InputFactory.types();
    const whitelistedTypes: IObsListOption<TSourceType>[] = [
      { description: 'Image', value: 'image_source' },
      { description: 'Color Source', value: 'color_source' },
      { description: 'Ad Layer', value: 'browser_source' },
      { description: 'Media Source', value: 'ffmpeg_source' },
      { description: 'Image Slide Show', value: 'slideshow' },
      { description: 'Text (GDI+)', value: 'text_gdiplus' },
      { description: 'Text (FreeType 2)', value: 'text_ft2_source' },
      { description: 'Display Capture', value: 'monitor_capture' },
      { description: 'Window Capture', value: 'window_capture' },
      { description: 'Game Capture', value: 'game_capture' },
      { description: 'Video Capture Device', value: 'dshow_input' },
      { description: 'Audio Input Capture', value: 'wasapi_input_capture' },
      { description: 'Audio Output Capture', value: 'wasapi_output_capture' },
      { description: 'Blackmagic Device', value: 'decklink-input' },
      { description: 'NDI Source', value: 'ndi_source' },
      { description: 'OpenVR Capture', value: 'openvr_capture' },
      { description: 'LIV Client Capture', value: 'liv_capture' },
      { description: 'OvrStream', value: 'ovrstream_dc_source' }
    ];

    const availableWhitelistedType = whitelistedTypes.filter(type => obsAvailableTypes.includes(type.value));
    // 'scene' is not an obs input type so we have to set it manually
    availableWhitelistedType.push({ description: 'Scene', value: 'scene' });

    return availableWhitelistedType;
  }

  getAvailableSourcesTypes(): TSourceType[] {
    return this.getAvailableSourcesTypesList().map(listItem => listItem.value);
  }

  refreshSourceAttributes() {
    const activeItems = this.scenesService.activeScene.getItems();
    const sourcesNames: string[] = [];

    activeItems.forEach(activeItem => {
      sourcesNames.push(activeItem.name);
    });

    const sourcesSize = obs.getSourcesSize(sourcesNames);

    activeItems.forEach((item, index) => {
      const source = this.state.sources[item.sourceId];

      if ((source.width !== sourcesSize[index].width) || (source.height !== sourcesSize[index].height)) {
        const size = { id: item.sourceId, width: sourcesSize[index].width,
          height: sourcesSize[index].height };
        this.UPDATE_SOURCE(size);
      }
      this.updateSourceFlags(source, sourcesSize[index].outputFlags);
    });
  }

  requestSourceSizes() {
    const activeScene = this.scenesService.activeScene;
    if (activeScene) {
      const activeItems = activeScene.getItems();
      const sourcesNames: string[] = [];

      activeItems.forEach(activeItem => {
        sourcesNames.push(activeItem.sourceId);
      });

      const sizes: obs.ISourceSize[] = obs.getSourcesSize(sourcesNames);
      sizes.forEach(update => {
        const source = this.getSource(update.name);

        if (!source) return;

        if ((source.width !== update.width) || (source.height !== update.height)) {
          const size = { id: source.sourceId, width: update.width,
            height: update.height };
          this.UPDATE_SOURCE(size);
        }
        this.updateSourceFlags(source, update.outputFlags);
      });
    }
  }

  private updateSourceFlags(source: ISource, flags: number, doNotEmit? : boolean) {
    const audio = !!(AudioFlag & flags);
    const video = !!(VideoFlag & flags);
    const async = !!(AsyncFlag & flags);
    const doNotDuplicate = !!(DoNotDuplicateFlag & flags);

    if ((source.audio !== audio) || (source.video !== video)) {
      this.UPDATE_SOURCE({ id: source.sourceId, audio, video, async, doNotDuplicate });

      if (!doNotEmit) this.sourceUpdated.next(source);
    }
  }


  setMuted(id: string, muted: boolean) {
    const source = this.getSource(id);
    source.getObsInput().muted = muted;
    this.UPDATE_SOURCE({ id, muted });
    this.sourceUpdated.next(source.sourceState);
  }


  reset() {
    this.RESET_SOURCES();
  }

  // Utility functions / getters

  getSourceById(id: string): Source {
    return this.getSource(id);
  }


  getSourcesByName(name: string): Source[] {
    const sourceModels = Object.values(this.state.sources).filter(source => {
      return source.name === name;
    });
    return sourceModels.map(sourceModel => this.getSource(sourceModel.sourceId));
  }


  get sources(): Source[] {
    return Object.values(this.state.sources).map(sourceModel => this.getSource(sourceModel.sourceId));
  }


  getSource(id: string): Source {
    return this.state.sources[id] || this.state.temporarySources[id] ? new Source(id) : void 0;
  }


  getSources() {
    return this.sources;
  }


  showSourceProperties(sourceId: string) {
    const source = this.getSource(sourceId);
    const propertiesManagerType = source.getPropertiesManagerType();
    const isWidget = propertiesManagerType === 'widget';

    // show a custom component for widgets below
    const widgetsWhitelist = [
      WidgetType.BitGoal,
      WidgetType.DonationGoal,
      WidgetType.FollowerGoal,
      WidgetType.ChatBox,
      WidgetType.ViewerCount,
      WidgetType.DonationTicker,
      WidgetType.Credits,
      WidgetType.EventList,
      WidgetType.StreamBoss,
      WidgetType.TipJar,
      WidgetType.SubGoal,
      WidgetType.MediaShare,
      WidgetType.SponsorBanner
    ];

    if (isWidget && this.userService.isLoggedIn()) {
      const widgetType = source.getPropertiesManagerSettings().widgetType;
      if (widgetsWhitelist.includes(widgetType)) {
        const componentName = this.widgetsService.getWidgetComponent(widgetType);

        this.windowsService.showWindow({
          componentName,
          title: $t('Settings for ') + WidgetDisplayData()[widgetType].name,
          queryParams: { sourceId },
          size: {
            width: 900,
            height: 1024
          }
        });

        return;
      }
    }

    // Figure out if we should redirect to settings
    if (propertiesManagerType === 'platformApp') {
      const settings = source.getPropertiesManagerSettings();
      const app = this.platformAppsService.getApp(settings.appId);

      if (app) {
        const page = app.manifest.sources.find(appSource => {
          return appSource.id === settings.appSourceId;
        });

        if (page && page.redirectPropertiesToTopNavSlot) {
          this.navigationService.navigate('PlatformAppContainer', {
            appId: app.id,
            sourceId: source.sourceId
          });

          // If we navigated, we don't want to open source properties,
          // and should close any open child windows instead
          this.windowsService.closeChildWindow();
          return;
        }
      }
    }

    this.windowsService.showWindow({
      componentName: 'SourceProperties',
      title: $t('Settings for ') + SourceDisplayData()[source.type].name,
      queryParams: { sourceId },
      size: {
        width: 605,
        height: 805
      }
    });
  }


  showShowcase() {
    this.windowsService.showWindow({
      componentName: 'SourcesShowcase',
      title: $t('Add Source'),
      size: {
        width: 1000,
        height: 650
      }
    });
  }


  showAddSource(sourceType: TSourceType, sourceAddOptions?: ISourceAddOptions) {
    this.windowsService.showWindow({
      componentName: 'AddSource',
      title: $t('Add Source'),
      queryParams: { sourceType, sourceAddOptions },
      size: {
        width: 600,
        height: 540
      }
    });
  }

  showRenameSource(sourceId: string) {
    this.windowsService.showWindow({
      componentName: 'RenameSource',
      title: $t('Rename Source'),
      queryParams: { sourceId },
      size: {
        width: 400,
        height: 250
      }
    });
  }

}
