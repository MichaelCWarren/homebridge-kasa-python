import { Categories } from 'homebridge';
import type { Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';

import { EventEmitter } from 'node:events';

import HomeKitDevice from './index.js';
import { deferAndCombine } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { ChildDevice, KasaDevice, Switch, SysInfo } from './kasaDevices.js';

export default class HomeKitDeviceSwitchWithChildren extends HomeKitDevice {
  public isUpdating: boolean = false;
  private previousKasaDevice: KasaDevice | undefined;
  private getSysInfo: () => Promise<void>;
  private pollingInterval: NodeJS.Timeout | undefined;
  private updateEmitter: EventEmitter = new EventEmitter();
  private static locks: Map<string, Promise<void>> = new Map();

  constructor(
    platform: KasaPythonPlatform,
    public kasaDevice: Switch,
  ) {
    super(
      platform,
      kasaDevice,
      Categories.SWITCH,
      'SWITCH',
    );
    this.log.debug(`Initializing HomeKitDeviceSwitch for device: ${kasaDevice.sys_info.alias}`);
    this.kasaDevice.sys_info.children?.forEach((child: ChildDevice, index: number) => {
      this.checkService(child, index);
    });

    this.getSysInfo = deferAndCombine(async () => {
      if (this.deviceManager) {
        this.previousKasaDevice = JSON.parse(JSON.stringify(this.kasaDevice));
        this.kasaDevice.sys_info = await this.deviceManager.getSysInfo(this.kasaDevice.sys_info.host) as SysInfo;
        this.log.debug(`Updated sys_info for device: ${this.kasaDevice.sys_info.alias}`);
      } else {
        this.log.warn('Device manager is not available');
      }
    }, platform.config.advancedOptions.waitTimeUpdate);

    this.startPolling();

    platform.periodicDeviceDiscoveryEmitter.on('periodicDeviceDiscoveryComplete', () => {
      this.updateEmitter.emit('periodicDeviceDiscoveryComplete');
    });
  }

  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    let lock = HomeKitDeviceSwitchWithChildren.locks.get(key);
    if (!lock) {
      lock = Promise.resolve();
    }
    const currentLock = lock.then(async () => {
      try {
        return await action();
      } finally {
        if (HomeKitDeviceSwitchWithChildren.locks.get(key) === currentLock) {
          HomeKitDeviceSwitchWithChildren.locks.delete(key);
        }
      }
    });
    HomeKitDeviceSwitchWithChildren.locks.set(key, currentLock.then(() => {}));
    return currentLock;
  }

  private checkService(child: ChildDevice, index: number) {
    const { Lightbulb, Fanv2 } = this.platform.Service;
    const serviceType = child.fan_speed_level !== undefined ? Fanv2 : Lightbulb;
    const service: Service =
      this.homebridgeAccessory.getServiceById(serviceType, `child-${index + 1}`) ??
      this.addService(serviceType, child.alias, `child-${index + 1}`);
    this.checkCharacteristics(service, child);
  }

  private checkCharacteristics(service: Service, child: ChildDevice) {
    const characteristics: { type: WithUUID<new () => Characteristic>; name: string | undefined }[] = [];

    if (child.fan_speed_level !== undefined) {
      characteristics.push(
        {
          type: this.platform.Characteristic.RotationSpeed,
          name: this.platform.getCharacteristicName(this.platform.Characteristic.RotationSpeed),
        },
        {
          type: this.platform.Characteristic.Active,
          name: this.platform.getCharacteristicName(this.platform.Characteristic.Active),
        },
      );
    }
    if (child.brightness !== undefined) {
      characteristics.push(
        {
          type: this.platform.Characteristic.On,
          name: this.platform.getCharacteristicName(this.platform.Characteristic.On),
        },
        {
          type: this.platform.Characteristic.Brightness,
          name: this.platform.getCharacteristicName(this.platform.Characteristic.Brightness),
        },
      );
    }

    characteristics.forEach(({ type, name }) => {
      this.getOrAddCharacteristic(service, type, name, child);
    });
  }

  private getOrAddCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
    child: ChildDevice,
  ) {
    const characteristic: Characteristic = service.getCharacteristic(characteristicType) ??
      service.addCharacteristic(characteristicType);
    characteristic.onGet(this.handleOnGet.bind(this, service, characteristicType, characteristicName, child));
    characteristic.onSet(this.handleOnSet.bind(this, service, characteristicType, characteristicName, child));
  }

  private async handleOnGet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
    child: ChildDevice,
  ): Promise<CharacteristicValue> {
    if (this.kasaDevice.offline || this.platform.isShuttingDown) {
      this.log.warn(`Device is offline or platform is shutting down, cannot get value for characteristic ${characteristicName}`);
      return this.getDefaultValue(characteristicType);
    }

    try {
      let characteristicValue = service.getCharacteristic(characteristicType).value;
      if (!characteristicValue) {
        characteristicValue = this.getInitialValue(characteristicType, child);
        service.getCharacteristic(characteristicType).updateValue(characteristicValue);
      }
      this.log.debug(`Got value for characteristic ${characteristicName}: ${characteristicValue}`);
      return characteristicValue ?? this.getDefaultValue(characteristicType);
    } catch (error) {
      this.log.error(`Error getting current value for characteristic ${characteristicName} for device: ${child.alias}:`, error);
      this.kasaDevice.offline = true;
      this.stopPolling();
      return this.getDefaultValue(characteristicType);
    }
  }

  private getDefaultValue(characteristicType: WithUUID<new () => Characteristic>): CharacteristicValue {
    const zeroValueCharacteristics: WithUUID<new () => Characteristic>[] = [
      this.platform.Characteristic.Brightness,
      this.platform.Characteristic.RotationSpeed,
    ];

    if (zeroValueCharacteristics.includes(characteristicType)) {
      return 0;
    } else if (characteristicType === this.platform.Characteristic.Active) {
      return this.platform.Characteristic.Active.INACTIVE;
    }
    return false;
  }

  private getInitialValue(characteristicType: WithUUID<new () => Characteristic>, child: ChildDevice): CharacteristicValue {
    if (characteristicType === this.platform.Characteristic.Active) {
      return child.state ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
    } else if (characteristicType === this.platform.Characteristic.Brightness) {
      return child.brightness ?? 0;
    } else if (characteristicType === this.platform.Characteristic.RotationSpeed) {
      return this.mapRotationSpeedToValue(child.fan_speed_level!) ?? 0;
    } else if (characteristicType === this.platform.Characteristic.On) {
      return child.state ?? false;
    }
    return false;
  }

  private mapRotationSpeedToValue(value: number): number {
    if (value === 0) {
      return 0;
    } else if (value === 1) {
      return 25;
    } else if (value === 2) {
      return 50;
    } else if (value === 3) {
      return 75;
    } else if (value === 4) {
      return 100;
    }
    return 0;
  }

  private async handleOnSet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
    child: ChildDevice,
    value: CharacteristicValue,
  ): Promise<void> {
    const lockKey = `${this.kasaDevice.sys_info.device_id}:${child.id}`;
    await this.withLock(lockKey, async () => {
      if (this.kasaDevice.offline || this.platform.isShuttingDown) {
        this.log.warn(`Device is offline or platform is shutting down, cannot set value for characteristic ${characteristicName}`);
        return;
      }

      if (this.isUpdating || this.platform.periodicDeviceDiscovering) {
        await Promise.race([
          new Promise<void>((resolve) => this.updateEmitter.once('updateComplete', resolve)),
          new Promise<void>((resolve) => this.updateEmitter.once('periodicDeviceDiscoveryComplete', resolve)),
        ]);
      }

      const task = async () => {
        if (this.deviceManager) {
          try {
            this.isUpdating = true;
            this.log.debug(`Setting value for characteristic ${characteristicName} to ${value}`);

            const characteristicMap: { [key: string]: string } = {
              Active: 'state',
              Brightness: 'brightness',
              RotationSpeed: 'fan_speed_level',
              On: 'state',
            };

            const characteristicKey = characteristicMap[characteristicName ?? ''];
            if (!characteristicKey) {
              throw new Error(`Characteristic key not found for ${characteristicName}`);
            }

            const childNumber = parseInt(child.id.slice(-1), 10);
            let controlValue: CharacteristicValue = value;
            if (characteristicName === 'Active') {
              controlValue = value === 1 ? true : false;
            } else if (characteristicName === 'RotationSpeed') {
              if (value === 0) {
                value = 0;
                controlValue = 0;
              } else if (value as number >= 1 && value as number <= 25) {
                value = 25;
                controlValue = 1;
              } else if (value as number >= 26 && value as number <= 50) {
                value = 50;
                controlValue = 2;
              } else if (value as number >= 51 && value as number <= 75) {
                value = 75;
                controlValue = 3;
              } else if (value as number >= 76 && value as number <= 100) {
                value = 100;
                controlValue = 4;
              }
            }
            await this.deviceManager.controlDevice(this.kasaDevice.sys_info.host, characteristicKey, controlValue, childNumber);
            (child[characteristicKey as keyof ChildDevice] as unknown as CharacteristicValue) = controlValue;

            const childIndex = this.kasaDevice.sys_info.children?.findIndex(c => c.id === child.id);
            if (childIndex !== undefined && childIndex !== -1) {
                this.kasaDevice.sys_info.children![childIndex] = { ...child };
            }

            this.updateValue(service, service.getCharacteristic(characteristicType), child.alias, value);

            this.previousKasaDevice = JSON.parse(JSON.stringify(this.kasaDevice));
            this.log.debug(`Set value for characteristic ${characteristicName} to ${value} successfully`);
          } catch (error) {
            this.log.error(`Error setting current value for characteristic ${characteristicName} for device: ${child.alias}:`, error);
            this.kasaDevice.offline = true;
            this.stopPolling();
          } finally {
            this.isUpdating = false;
            this.updateEmitter.emit('updateComplete');
          }
        } else {
          throw new Error('Device manager is undefined.');
        }
      };
      await task();
    });
  }

  protected async updateState() {
    const lockKey = `${this.kasaDevice.sys_info.device_id}`;
    await this.withLock(lockKey, async () => {
      if (this.kasaDevice.offline || this.platform.isShuttingDown) {
        this.stopPolling();
        return;
      }
      if (this.isUpdating || this.platform.periodicDeviceDiscovering) {
        let periodicDiscoveryComplete = false;
        await Promise.race([
          new Promise<void>((resolve) => this.updateEmitter.once('updateComplete', resolve)),
          new Promise<void>((resolve) => {
            this.updateEmitter.once('periodicDeviceDiscoveryComplete', () => {
              periodicDiscoveryComplete = true;
              resolve();
            });
          }),
        ]);
        if (periodicDiscoveryComplete) {
          await new Promise((resolve) => setTimeout(resolve, this.platform.config.discoveryOptions.pollingInterval));
        }
      }
      this.isUpdating = true;
      const task = async () => {
        try {
          await this.getSysInfo();
          this.kasaDevice.sys_info.children?.forEach((child: ChildDevice) => {
            const childNumber = parseInt(child.id.slice(-1), 10);
            let service;
            if (child.brightness !== undefined) {
              service = this.homebridgeAccessory.getServiceById(this.platform.Service.Lightbulb, `child-${childNumber + 1}`);
            } else if (child.fan_speed_level !== undefined) {
              service = this.homebridgeAccessory.getServiceById(this.platform.Service.Fanv2, `child-${childNumber + 1}`);
            }
            if (service && service.UUID === this.platform.Service.Lightbulb.UUID && this.previousKasaDevice) {
              const previousChild = this.previousKasaDevice.sys_info.children?.find(c => c.id === child.id);
              if (previousChild) {
                if (previousChild.state !== child.state) {
                  this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.On), child.alias, child.state);
                  this.log.debug(`Updated state for child device: ${child.alias} to ${child.state}`);
                }
                if (child.brightness !== undefined && previousChild.brightness !== child.brightness) {
                  this.updateValue(
                    service,
                    service.getCharacteristic(this.platform.Characteristic.Brightness),
                    child.alias,
                    (child.brightness as number) as CharacteristicValue,
                  );
                  this.log.debug(`Updated brightness for child device: ${child.alias} to ${child.brightness}`);
                }
              }
            } else if (service && service.UUID === this.platform.Service.Fanv2.UUID && this.previousKasaDevice) {
              const previousChild = this.previousKasaDevice.sys_info.children?.find(c => c.id === child.id);
              if (previousChild) {
                if (previousChild.state !== child.state) {
                  this.updateValue(
                    service,
                    service.getCharacteristic(this.platform.Characteristic.Active),
                    child.alias,
                    child.state ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE,
                  );
                  this.log.debug(`Updated state for child device: ${child.alias} to ${child.state}`);
                }
                if (child.fan_speed_level !== undefined && previousChild.fan_speed_level !== child.fan_speed_level) {
                  const updateValue = this.mapRotationSpeedToValue(child.fan_speed_level as number);
                  this.updateValue(
                    service,
                    service.getCharacteristic(this.platform.Characteristic.RotationSpeed),
                    child.alias,
                    updateValue,
                  );
                  this.log.debug(`Updated fan speed for child device: ${child.alias} to ${updateValue}`);
                }
              }
            } else {
              this.log.warn(`Service not found for child device: ${child.alias} or previous Kasa device is undefined`);
            }
          });
        } catch (error) {
          this.log.error('Error updating device state:', error);
          this.kasaDevice.offline = true;
          this.stopPolling();
        } finally {
          this.isUpdating = false;
          this.updateEmitter.emit('updateComplete');
        }
      };
      await task();
    });
  }

  public updateAfterPeriodicDiscovery() {
    this.kasaDevice.sys_info.children?.forEach((child: ChildDevice, index: number) => {
      const { Lightbulb, Fanv2 } = this.platform.Service;
      const serviceType = child.fan_speed_level !== undefined ? Fanv2 : Lightbulb;
      const service: Service | undefined=
        this.homebridgeAccessory.getServiceById(serviceType, `child-${index + 1}`);
      if (service) {
        const characteristics: { type: WithUUID<new () => Characteristic>; name: string | undefined }[] = [];
        if (child.fan_speed_level !== undefined) {
          characteristics.push(
            {
              type: this.platform.Characteristic.RotationSpeed,
              name: this.platform.getCharacteristicName(this.platform.Characteristic.RotationSpeed),
            },
            {
              type: this.platform.Characteristic.Active,
              name: this.platform.getCharacteristicName(this.platform.Characteristic.Active),
            },
          );
        }
        if (child.brightness !== undefined) {
          characteristics.push(
            {
              type: this.platform.Characteristic.On,
              name: this.platform.getCharacteristicName(this.platform.Characteristic.On),
            },
            {
              type: this.platform.Characteristic.Brightness,
              name: this.platform.getCharacteristicName(this.platform.Characteristic.Brightness),
            },
          );
        }
        characteristics.forEach(({ type, name }) => {
          const characteristic: Characteristic = service.getCharacteristic(type);
          if (characteristic) {
            const characteristicMap: { [key: string]: string } = {
              Active: 'state',
              Brightness: 'brightness',
              RotationSpeed: 'fan_speed_level',
              On: 'state',
            };
            const characteristicKey = characteristicMap[name ?? ''];
            if (!characteristicKey) {
              throw new Error(`Characteristic key not found for ${name}`);
            }
            if (child[characteristicKey as keyof ChildDevice] !== undefined) {
              const value = child[characteristicKey as keyof ChildDevice] as unknown as CharacteristicValue;
              let controlValue: CharacteristicValue = value;
              if (name === 'Active') {
                controlValue = value ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
              } else if (name === 'RotationSpeed') {
                controlValue = this.mapRotationSpeedToValue(value as number);
              }
              this.log.debug(`Setting value for characteristic ${name} to ${controlValue}`);
              this.updateValue(service, characteristic, child.alias, controlValue);
            }
          }
        });
      } else {
        this.log.debug(`Service not found for child device: ${child.alias}`);
      }
    });
  }

  public startPolling() {
    if (this.kasaDevice.offline || this.platform.isShuttingDown) {
      this.stopPolling();
      return;
    }

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    this.log.debug('Starting polling for device:', this.name);
    this.pollingInterval = setInterval(async () => {
      if (this.kasaDevice.offline || this.platform.isShuttingDown) {
        if (this.isUpdating) {
          this.isUpdating = false;
          this.updateEmitter.emit('updateComplete');
        }
        this.stopPolling();
      } else {
        await this.updateState();
      }
    }, this.platform.config.discoveryOptions.pollingInterval);
  }

  public stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
      this.log.debug('Stopped polling');
    }
  }

  identify(): void {
    this.log.info('identify');
  }
}