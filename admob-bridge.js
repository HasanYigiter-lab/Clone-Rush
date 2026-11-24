import { Capacitor } from '@capacitor/core';
import {
  AdMob,
  AdmobConsentStatus,
  BannerAdPosition,
  BannerAdSize,
} from '@capacitor-community/admob';

// Keep true while testing. Change to false only after the test build is verified.
const TEST_MODE = true;

const AD_UNITS = {
  banner: 'ca-app-pub-3173758070343843/8727460148',
  interstitial: 'ca-app-pub-3173758070343843/6264627536',
  rewarded: 'ca-app-pub-3173758070343843/7985224111',
};

let initialized = false;
let consentAllowsAds = false;
let privacyOptionsRequired = false;
let bannerVisible = false;
let bannerBusy = false;
let interstitialReady = false;
let currentScreen = 'menu';
let interstitialBusy = false;
let rewardedBusy = false;

const isNative = () => Capacitor.isNativePlatform();
const isBannerScreen = (screen) =>
  ['menu', 'shop', 'pg', 'end'].includes(screen);

function setBannerClass(visible) {
  const app = document.getElementById('app');
  if (app) app.classList.toggle('ad-banner-visible', !!visible);
}

async function loadInterstitial() {
  if (!initialized || !consentAllowsAds) return false;
  try {
    await AdMob.prepareInterstitial({
      adId: AD_UNITS.interstitial,
      isTesting: TEST_MODE,
      immersiveMode: true,
    });
    interstitialReady = true;
    return true;
  } catch (error) {
    interstitialReady = false;
    console.warn('[Gem Rush] Interstitial load failed:', error);
    return false;
  }
}

async function init() {
  if (!isNative()) return false;
  if (initialized) return true;

  try {
    let consent = await AdMob.requestConsentInfo();
    if (
      consent.isConsentFormAvailable &&
      consent.status === AdmobConsentStatus.REQUIRED
    ) {
      consent = await AdMob.showConsentForm();
    }

    consentAllowsAds = !!consent.canRequestAds;
    privacyOptionsRequired = consent.privacyOptionsRequirementStatus === 'REQUIRED';
    if (!consentAllowsAds) return false;

    await AdMob.initialize();
    initialized = true;

    // Preload a full-screen ad early; never block gameplay on an ad load.
    void loadInterstitial();
    return true;
  } catch (error) {
    console.warn('[Gem Rush] AdMob initialization failed:', error);
    initialized = false;
    consentAllowsAds = false;
    return false;
  }
}

async function setBanner(visible) {
  if (!initialized || !consentAllowsAds || bannerBusy) return;
  bannerBusy = true;
  try {
    if (visible && !bannerVisible) {
      await AdMob.showBanner({
        adId: AD_UNITS.banner,
        adSize: BannerAdSize.ADAPTIVE_BANNER,
        position: BannerAdPosition.BOTTOM_CENTER,
        margin: 0,
        isTesting: TEST_MODE,
      });
      bannerVisible = true;
      setBannerClass(true);
    } else if (!visible && bannerVisible) {
      await AdMob.hideBanner();
      bannerVisible = false;
      setBannerClass(false);
    }
  } catch (error) {
    console.warn('[Gem Rush] Banner operation failed:', error);
    bannerVisible = false;
    setBannerClass(false);
  } finally {
    bannerBusy = false;
  }
}

function setScreen(screen) {
  currentScreen = screen;
  void setBanner(isBannerScreen(screen));
}

async function showInterstitial() {
  if (!initialized || !consentAllowsAds || interstitialBusy) return false;
  interstitialBusy = true;
  try {
    await setBanner(false);
    if (!interstitialReady && !(await loadInterstitial())) return false;
    await AdMob.showInterstitial();
    interstitialReady = false;
    void loadInterstitial();
    return true;
  } catch (error) {
    interstitialReady = false;
    console.warn('[Gem Rush] Interstitial show failed:', error);
    void loadInterstitial();
    return false;
  } finally {
    interstitialBusy = false;
    if (isBannerScreen(currentScreen)) void setBanner(true);
  }
}

async function showRewarded() {
  if (!initialized || !consentAllowsAds || rewardedBusy) return false;
  rewardedBusy = true;
  try {
    await setBanner(false);
    await AdMob.prepareRewardVideoAd({
      adId: AD_UNITS.rewarded,
      isTesting: TEST_MODE,
      immersiveMode: true,
    });
    const reward = await AdMob.showRewardVideoAd();
    // The plugin resolves this promise only after the reward event is earned.
    return !!reward;
  } catch (error) {
    console.warn('[Gem Rush] Rewarded ad unavailable or not completed:', error);
    return false;
  } finally {
    rewardedBusy = false;
    if (isBannerScreen(currentScreen)) void setBanner(true);
  }
}

window.GemRushAdMob = {
  init,
  isNative,
  isReady: () => initialized && consentAllowsAds,
  setScreen,
  showInterstitial,
  showRewarded,
  privacyOptionsRequired: () => privacyOptionsRequired,
  showPrivacyOptionsForm: async () => {
    if (!initialized || !privacyOptionsRequired) return false;
    try { await AdMob.showPrivacyOptionsForm(); return true; }
    catch (error) { console.warn('[Gem Rush] Privacy options form failed:', error); return false; }
  },
};
