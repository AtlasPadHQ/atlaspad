/**
 * Window-level custom events shared between modules. SHARED (src/lib).
 *
 *  - LAYOUT_EVENT: App dispatches it after layout-affecting changes settle (panel open/close/
 *    collapse 320ms, mobile sheet snaps and hero dismissal 460ms). MapView resizes the map on it.
 *  - LAUNCH_PULSE_EVENT: the map dispatches it when the launchable balloon is clicked
 *    (DESIGN §18.1). The place panel scrolls to the top and pulses its Launch action once.
 *    detail: { fromKeyboard: boolean } (keyboard activation also moves focus to Launch).
 */
export const LAYOUT_EVENT = 'cs:layout';
export const LAUNCH_PULSE_EVENT = 'cs:launch-pulse';

export interface LaunchPulseDetail {
  fromKeyboard: boolean;
}
