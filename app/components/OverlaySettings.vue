<template>
<div>
  <div class="section">
    <p>{{ $t('This is an Experimental feature.  Use at your own risk.') }}</p>

    <button
      class="button button--action"
      :disabled="busy"
      @click="saveOverlay">
      {{ $t('Export Overlay File') }}
      <i class="fa fa-spinner fa-pulse" v-if="busy" />
    </button>
    <button
      class="button button--action"
      :disabled="busy"
      @click="loadOverlay">
      {{ $t('Import Overlay File') }}
      <i class="fa fa-spinner fa-pulse" v-if="busy" />
    </button>
    <br/>
    {{ message }}
  </div>
  <div class="section">
    <button
      class="button button--action"
      :disabled="busy"
      @click="loadWidget">
      {{ $t('Import Widget File in Current Scene') }}
      <i class="fa fa-spinner fa-pulse" v-if="busy" />
    </button>
  </div>
  <div class="section">
    <div class="section-content">
      <ObsBoolInput :value="mediaBackupOptOut" @input="setMediaBackupOptOut" />
    </div>
  </div>
</div>
</template>

<script lang="ts" src="./OverlaySettings.vue.ts"></script>
