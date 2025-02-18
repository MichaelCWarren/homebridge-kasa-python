import { Categories } from 'homebridge';
import type { Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';

import { EventEmitter } from 'node:events';

import HomeKitDevice from './index.js';
import { deferAndCombine } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { ChildDevice, KasaDevice, PowerStrip, SysInfo } from './kasaDevices.js';

export default class HomeKitDevicePowerStrip extends HomeKitDevice {
  public isUpdating: boolean = false;
  private previousKasaDevice: KasaDevice | undefined;
  private getSysInfo: () => Promise<void>;
  private pollingInterval: NodeJS.Timeout | undefined;
  private updateEmitter: EventEmitter = new EventEmitter();
  private static locks: Map<string, Promise<void>> = new Map();

  constructor(
    platform: KasaPythonPlatform,
    public kasaDevice: PowerStrip,
  ) {
    super(
      platform,
      kasaDevice,
      Categories.OUTLET,
      'OUTLET',
    );
    this.log.debug(`Initializing HomeKitDevicePowerStrip for device: ${kasaDevice.sys_info.alias}`);
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
    let lock = HomeKitDevicePowerStrip.locks.get(key);
    if (!lock) {
      lock = Promise.resolve();
    }
    const currentLock = lock.then(async () => {
      try {
        return await action();
      } finally {
        if (HomeKitDevicePowerStrip.locks.get(key) === currentLock) {
          HomeKitDevicePowerStrip.locks.delete(key);
        }
      }
    });
    HomeKitDevicePowerStrip.locks.set(key, currentLock.then(() => {}));
    return currentLock;
  }

  private checkService(child: ChildDevice, index: number) {
    const serviceType = this.getServiceType();
    const service: Service =
      this.homebridgeAccessory.getServiceById(serviceType, `child-${index + 1}`) ??
      this.addService(serviceType, child.alias, `child-${index + 1}`);
    const oldService: Service | undefined = this.homebridgeAccessory.getServiceById(serviceType, `outlet-${index + 1}`);
    if (oldService) {
      this.homebridgeAccessory.removeService(oldService);
    }
    this.checkCharacteristics(service, child);
  }

  private getServiceType() {
    const { Outlet } = this.platform.Service;
    return Outlet;
  }

  private checkCharacteristics(service: Service, child: ChildDevice) {
    const characteristics = this.getCharacteristics();
    characteristics.forEach(({ type, name }) => {
      this.getOrAddCharacteristic(service, type, name, child);
    });
  }

  private getCharacteristics() {
    const characteristics: { type: WithUUID<new () => Characteristic>; name: string | undefined }[] = [];
    characteristics.push(
      {
        type: this.platform.Characteristic.On,
        name: this.platform.getCharacteristicName(this.platform.Characteristic.On),
      },
      {
        type: this.platform.Characteristic.OutletInUse,
        name: this.platform.getCharacteristicName(this.platform.Characteristic.OutletInUse),
      },
    );
    return characteristics;
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
    if (characteristicType === this.platform.Characteristic.On) {
      characteristic.onSet(this.handleOnSet.bind(this, service, characteristicType, characteristicName, child));
    }
  }

  private async handleOnGet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
    child: ChildDevice,
  ): Promise<CharacteristicValue> {
    if (this.kasaDevice.offline || this.platform.isShuttingDown) {
      this.log.warn(`Device is offline or platform is shutting down, cannot get value for characteristic ${characteristicName}`);
      return false;
    }
    try {
      let characteristicValue = service.getCharacteristic(characteristicType).value;
      if (!characteristicValue) {
        characteristicValue = this.getInitialValue(characteristicType, child);
        service.getCharacteristic(characteristicType).updateValue(characteristicValue);
      }
      this.log.debug(`Got value for characteristic ${characteristicName}: ${characteristicValue}`);
      return characteristicValue ?? false;
    } catch (error) {
      this.log.error(`Error getting current value for characteristic ${characteristicName} for device: ${child.alias}:`, error);
      this.kasaDevice.offline = true;
      this.stopPolling();
      return false;
    }
  }

  private getInitialValue(characteristicType: WithUUID<new () => Characteristic>, child: ChildDevice): CharacteristicValue {
    if (characteristicType === this.platform.Characteristic.On || characteristicType === this.platform.Characteristic.OutletInUse) {
      return child.state ?? false;
    }
    return false;
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
            const characteristicKey = this.getCharacteristicKey(characteristicName);
            if (!characteristicKey) {
              throw new Error(`Characteristic key not found for ${characteristicName}`);
            }
            const childNumber = parseInt(child.id.slice(-1), 10);
            await this.deviceManager.controlDevice(this.kasaDevice.sys_info.host, characteristicKey, value, childNumber);
            (child as Record<string, CharacteristicValue>)[characteristicKey] = value;
            const childIndex = this.kasaDevice.sys_info.children?.findIndex(c => c.id === child.id);
            if (childIndex !== undefined && childIndex !== -1) {
              this.kasaDevice.sys_info.children![childIndex] = { ...child };
            }
            this.updateValue(service, service.getCharacteristic(characteristicType), child.alias, value);
            this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), child.alias, value);
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

  private getCharacteristicKey(characteristicName: string | undefined): string {
    const characteristicMap: { [key: string]: string } = {
      On: 'state',
    };
    return characteristicMap[characteristicName ?? ''];
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
          if (this.pollingInterval) {
            await new Promise((resolve) => setTimeout(resolve, this.platform.config.discoveryOptions.pollingInterval));
          } else {
            return;
          }
        }
      }
      this.isUpdating = true;
      const task = async () => {
        try {
          await this.getSysInfo();
          this.kasaDevice.sys_info.children?.forEach((child: ChildDevice) => {
            const childNumber = parseInt(child.id.slice(-1), 10);
            const service = this.getService(childNumber);
            if (service && this.previousKasaDevice) {
              this.updateChildState(service, child);
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

  private getService(childNumber: number) {
    return this.homebridgeAccessory.getServiceById(this.platform.Service.Outlet, `child-${childNumber + 1}`);
  }

  private updateChildState(service: Service, child: ChildDevice) {
    const previousChild = this.previousKasaDevice?.sys_info.children?.find(c => c.id === child.id);
    if (previousChild) {
      if (previousChild.state !== child.state) {
        this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.On), child.alias, child.state);
        this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), child.alias, child.state);
        this.log.debug(`Updated state for child device: ${child.alias} to ${child.state}`);
      }
    }
  }

  public updateAfterPeriodicDiscovery() {
    this.kasaDevice.sys_info.children?.forEach((child: ChildDevice, index: number) => {
      const serviceType = this.getServiceType();
      const service: Service | undefined =
        this.homebridgeAccessory.getServiceById(serviceType, `child-${index + 1}`);
      if (service) {
        this.updateCharacteristics(service, child);
      } else {
        this.log.debug(`Service not found for child device: ${child.alias}`);
      }
    });
  }

  private updateCharacteristics(service: Service, child: ChildDevice) {
    const characteristics = this.getCharacteristics();
    characteristics.forEach(({ type, name }) => {
      if (type === this.platform.Characteristic.On) {
        const characteristic: Characteristic = service.getCharacteristic(type);
        if (characteristic) {
          const characteristicKey = this.getCharacteristicKey(name);
          if (child[characteristicKey as keyof ChildDevice] !== undefined) {
            const value = child[characteristicKey as keyof ChildDevice] as unknown as CharacteristicValue;
            this.log.debug(`Setting value for characteristic ${name} to ${value}`);
            this.updateValue(service, characteristic, child.alias, value);
            this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), child.alias, value);
          }
        }
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