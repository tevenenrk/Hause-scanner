// Tryb emulacji WebXR na komputerze (Meta Immersive Web Emulation Runtime + prawdziwe skany pokoi z Questa).
// Użycie: index.html?emulate=office_small  (dostępne: office_small, living_room, meeting_room)

export const CAPTURES = ['office_small', 'living_room', 'meeting_room'];

export async function setupEmulation(envName, { devUI = true } = {}) {
  const env = CAPTURES.includes(envName) ? envName : 'office_small';
  const { XRDevice, metaQuest3 } = await import('iwer');
  const { SyntheticEnvironmentModule } = await import('../vendor/iwer/iwer-sem.module.min.js');
  const device = new XRDevice(metaQuest3, { stereoEnabled: false });
  device.installRuntime({ forceInstall: true });
  device.installSEM(SyntheticEnvironmentModule);
  if (devUI) try {
    const { DevUI } = await import('../vendor/iwer/iwer-devui.module.min.js');
    device.installDevUI(DevUI);
  } catch (e) {
    console.warn('IWER DevUI niedostępne:', e);
  }
  const json = await fetch(`dev/captures/${env}.json`).then((r) => r.json());
  device.sem.loadEnvironment(json);
  window.iwerDevice = device;
  return { device, env };
}
