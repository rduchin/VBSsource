import { Observable } from 'rxjs/Observable';
import { TObsFormData } from 'components/obs/inputs/ObsInput';

export interface ICustomizationServiceState {
  nightMode: boolean;
  updateStreamInfoOnLive: boolean;
  livePreviewEnabled: boolean;
  leftDock: boolean;
  hideViewerCount: boolean;
  folderSelection: boolean;
  livedockCollapsed: boolean;
  previewSize: number;
  livedockSize: number;
  performanceMode: boolean;
  chatZoomFactor: number;
  enableBTTVEmotes: boolean;
  enableFFZEmotes: boolean;
  mediaBackupOptOut: boolean;
  Experimental: any;
}

export interface ICustomizationSettings extends ICustomizationServiceState {}

export interface ICustomizationServiceApi {
  settingsChanged: Observable<Partial<ICustomizationSettings>>;
  setSettings(settingsPatch: Partial<ICustomizationSettings>): void;
  getSettings(): ICustomizationSettings;
  getSettingsFormData(): TObsFormData;
  getExperimentalSettingsFormData(): TObsFormData;
  restoreDefaults(): void;
}
