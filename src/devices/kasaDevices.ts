export type KasaDevice = Plug | Powerstrip | Switch;

interface DeviceCommonInfo {
  alias: string;
  host: string;
  is_off: boolean;
  is_on: boolean;
  sys_info: SysInfo;
}

export interface SysInfo {
  sw_ver: string;
  hw_ver: string;
  model: string;
  deviceId: string;
  mic_type?: string;
  type?: string;
  mac: string;
  led_off: number;
  relay_state: number;
  err_code: number;
  children?: ChildPlug[];
  child_num?: number;
}

export interface ChildPlug {
  id: string;
  state: number;
  alias: string;
}

export interface DeviceConfig {
  host: string;
  timeout: number;
  connection_type: {
    device_family: string;
    encryption_type: string;
  };
  uses_http: boolean;
}

export interface ConfigDevice {
  host: string;
  alias: string;
  breakoutChildDevices?: boolean;
}

export interface Plug extends DeviceCommonInfo {
  children?: ChildPlug[];
  device_config: DeviceConfig;
}

export interface Powerstrip extends DeviceCommonInfo {
  sys_info: SysInfo & { children: ChildPlug[]; child_num: number };
  device_config: DeviceConfig;
}

export interface Switch extends DeviceCommonInfo {
  device_config: DeviceConfig;
}

export const Switches = [
  'ES20M(US)',
  'HS200(US)',
  'HS210(US)',
  'HS220(US)',
  'KP405(US)',
  'KS200M(US)',
  'KS205(US)',
  'KS220M(US)',
  'KS225(US)',
  'KS230(US)',
  'KS240(US)',
  'S500D(US)',
  'S505(US)',
  'S505D(US)',
];

export const Plugs = [
  'EP10(US)',
  'EP25(US)',
  'HS100(UK)',
  'HS100(US)',
  'HS103(US)',
  'HS105(US)',
  'HS110(EU)',
  'HS110(US)',
  'KP100(US)',
  'KP105(UK)',
  'KP115(EU)',
  'KP115(US)',
  'KP125(US)',
  'KP125M(US)',
  'KP401(US)',
  'P100(US)',
  'P110(EU)',
  'P110(UK)',
  'P115(EU)',
  'P125M(US)',
  'P135(US)',
  'TP15(US)',
];

export const PowerStrips = [
  'EP40(US)',
  'HS107(US)',
  'HS300(US)',
  'KP200(US)',
  'KP303(UK)',
  'KP303(US)',
  'KP400(US)',
  'P300(EU)',
  'P304M(UK)',
  'TP25(US)',
];

export const Bulbs = [
  'KL110(US)',
  'KL120(US)',
  'KL125(US)',
  'KL130(EU)',
  'KL130(US)',
  'KL135(US)',
  'KL50(US)',
  'KL60(UN)',
  'KL60(US)',
  'LB110(US)',
  'L510B(EU)',
  'L510E(US)',
  'L530E(EU)',
  'L530E(US)',
];

export const LightStrips = [
  'KL400L5(US)',
  'KL420L5(US)',
  'KL430(UN)',
  'KL430(US)',
  'L900-10(EU)',
  'L900-10(US)',
  'L900-5(EU)',
  'L920-5(EU)',
  'L920-5(US)',
  'L930-5(US)',
];

export const Hubs = [
  'KH100(EU)',
  'KH100(UK)',
  'H100(EU)',
];

export const HubConnectedDevices = [
  'KE100(EU)',
  'KE100(UK)',
  'S200B(EU)',
  'S200B(US)',
  'S200D(EU)',
  'T100(EU)',
  'T110(EU)',
  'T110(US)',
  'T300(EU)',
  'T310(EU)',
  'T310(US)',
  'T315(EU)',
  'T315(US)',
];