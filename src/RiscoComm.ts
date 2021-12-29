/* 
 *  Package: risco-lan-bridge
 *  File: RiscoComm.js
 *  
 *  MIT License
 *  
 *  Copyright (c) 2021 TJForc
 *  
 *  Permission is hereby granted, free of charge, to any person obtaining a copy
 *  of this software and associated documentation files (the "Software"), to deal
 *  in the Software without restriction, including without limitation the rights
 *  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *  copies of the Software, and to permit persons to whom the Software is
 *  furnished to do so, subject to the following conditions:
 *  
 *  The above copyright notice and this permission notice shall be included in all
 *  copies or substantial portions of the Software.
 *  
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

'use strict'

import { RiscoBaseSocket } from './RiscoBaseSocket'
import { RiscoDirectTCPSocket } from './RiscoDirectSocket'
import { PanelType, RiscoError, TimeZoneStr } from './constants'
import { Output, OutputList } from './Devices/Outputs'
import { Zone, ZoneList } from './Devices/Zones'
import { Partition, PartitionList } from './Devices/Partitions'
import { MBSystem } from './Devices/System'
import { assertIsDefined } from './Assertions'
import { logger } from './Logger'
import { PanelOptions } from './RiscoPanel'
import { SocketOptions } from './RiscoBaseSocket'
import { RiscoCrypt } from './RiscoCrypt'
import { TypedEmitter } from 'tiny-typed-emitter'
import { RiscoProxyTCPSocket } from './RiscoProxySocket'

export class PanelInfo {

  public PanelType!: string
  public PanelModel!: string
  public PanelFW!: string
  public MaxZones!: number
  public MaxParts!: number
  public MaxOutputs!: number
  public SupportPirCam!: boolean

}

interface RiscoCommEvents {
  'PanelCommReady': (info: PanelInfo) => void
  'NewOutputStatusFromPanel': (data: string) => void
  'NewPartitionStatusFromPanel': (data: string) => void
  'NewMBSystemStatusFromPanel': (data: string) => void
  'NewZoneStatusFromPanel': (data: string) => void
  'Clock': (data: string) => void
}

export class RiscoComm extends TypedEmitter<RiscoCommEvents> {

  private readonly reconnectDelay: number
  private readonly watchDogInterval: number
  private readonly disableRC: boolean
  private readonly enableRC: boolean
  private readonly ntpServer: string
  private readonly ntpPort: number
  private readonly GMT_TZ: string

  private readonly socketOptions: SocketOptions
  private readonly rCrypt: RiscoCrypt

  panelInfo: PanelInfo | undefined

  tcpSocket: RiscoBaseSocket | undefined
  private isDisconnecting = false

  private autoReconnectTimer: NodeJS.Timeout | undefined
  private watchDogTimer: NodeJS.Timeout | undefined

  constructor(options: PanelOptions) {
    super()

    this.rCrypt = new RiscoCrypt({
      panelId: options.panelId || 1,
      encoding: options.encoding || 'utf-8'
    })

    this.socketOptions = {
      socketMode: options.socketMode || 'direct',
      panelIp: options.panelIp || '192.168.0.100',
      panelPort: options.panelPort || 1000,
      panelPassword: options.panelPassword && RiscoComm.looksLikePanelPwd(options.panelPassword) ? options.panelPassword.toString() : '5678',
      encoding: options.encoding || 'utf-8',
      guessPasswordAndPanelId: options.guessPasswordAndPanelId !== undefined ? options.guessPasswordAndPanelId : true,
      listeningPort: options.listeningPort || 33000,
      cloudUrl: (options.cloudUrl || 'www.riscocloud.com'),
      cloudPort: options.cloudPort || 33000,
      panelConnectionDelay: options.panelConnectionDelay || 30000
    }

    this.reconnectDelay = 10000
    this.disableRC = false
    this.enableRC = false
    this.ntpServer = options.ntpServer || 'pool.ntp.org'
    this.ntpPort = options.ntpPort || 123
    this.watchDogInterval = options.watchDogInterval || 5000
    this.GMT_TZ = RiscoComm.getGmtTimeZone();
  }

  private static getGmtTimeZone(): string {
    const now = new Date()
      const localTZ = (new Date(now.getFullYear(), 0, 1).getTimezoneOffset()) * -1
      const hours = (Math.abs(Math.floor(localTZ / 60))).toLocaleString('en-US', {
        minimumIntegerDigits: 2,
        useGrouping: false
      })
      const minutes = (Math.abs(localTZ % 60)).toLocaleString('en-US', {
        minimumIntegerDigits: 2,
        useGrouping: false
      })
      const prefix = (localTZ >= 0) ? '+' : '-'
      logger.log('debug', `Local GMT Timezone is : ${prefix}${hours}:${minutes}`)
      return `${prefix}${hours}:${minutes}`
  }

  private static looksLikePanelPwd(candidate: string): boolean {
    return /^\+?([0-9]\d*)$/.test(candidate.toString().trim()); // toString is important, as the value from the config file can be an integer at runtime
  }

  /*
   * Main function
   * Complete initialization of the Socket and connection to the control Panel.
   */
  async initRPSocket() {
    logger.log('verbose', `Start Connection to Panel`)
    //verify if listener exist before kill it
    if (this.tcpSocket !== undefined) {
      logger.log('debug', `TCP Socket is already created, Connect It`)
      this.tcpSocket.removeAllListeners()
    } else {
      logger.log('debug', `TCP Socket is not already created, Create It`)

      let tcpSocket: RiscoBaseSocket
      if (this.socketOptions.socketMode === 'proxy') {
        tcpSocket = new RiscoProxyTCPSocket(this.socketOptions, this.rCrypt)
      } else {
        tcpSocket = new RiscoDirectTCPSocket(this.socketOptions, this.rCrypt)
      }

      this.tcpSocket = tcpSocket

      //   const cloudSocket = new RiscoCloudSocket(this.socketOptions, this.rCrypt)
      //   cloudSocket.connect().then(() => {
      //     cloudSocket.CloudSocket.on('connect', () => {
      //       console.log('Cloud connected')
      //       tcpSocket.socket?.on('data', (data) => {
      //         if (data[1] === 19) {
      //           logger.log('info', 'Forwarding encrypted data to cloud')
      //           cloudSocket.write(data)
      //         }
      //       })
      //     })
      //   })
      // }
      // switch (this.ProxyMode) {
      //     case 'proxy':
      //         this.tcpSocket = new ProxySocket(this.socketOptions);
      //         break;
      //     case 'rs232':
      //     case 'direct':
      //     default:
      //         this.tcpSocket = new DirectSocket(this.socketOptions);
      //         break;
      // }
    }
    logger.log('debug', `TCP Socket must be created now`)

    this.tcpSocket.once('Disconnected', (allowReconnect: boolean) => {
      if (this.isDisconnecting || !allowReconnect) {
        logger.log('info', `TCP Socket Disconnected`)
        if (this.autoReconnectTimer !== undefined) {
          clearTimeout(this.autoReconnectTimer)
        }
      } else {
        logger.log('error', `TCP Socket Disconnected`)
        if (this.autoReconnectTimer === undefined) {
          this.autoReconnectTimer = setTimeout(() => {
            this.autoReconnectTimer = undefined
            this.initRPSocket()
          }, this.reconnectDelay)
        }
      }
    })

    this.tcpSocket.on('DataReceived', async (cmdId: number | null, data: string) => {
      await this.dataFromPanel(cmdId, data)
    })

    this.tcpSocket.on('DataSent', async (sequence_Id: number, data: string) => {
      await this.DataFromPlugin(data, sequence_Id)
    })

    this.tcpSocket.on('PanelConnected', async () => {
      logger.log('debug', `Risco Panel Connected.`)
      const panelType = await this.GetPanel_Type()
      this.panelInfo = await this.applyPanelOptions(panelType)

      logger.log('info', `Panel info: ${this.panelInfo.PanelModel}/${this.panelInfo.PanelType}, FW ${this.panelInfo.PanelFW || 'Unknown'}`)
      logger.log('info', `Panel options: ${this.panelInfo.MaxParts} parts, ${this.panelInfo.MaxZones} zones, ${this.panelInfo.MaxOutputs} outputs, Pir Cam support: ${this.panelInfo.SupportPirCam}`)

      const CommandsArr = await this.verifyPanelConfiguration()

      if ((CommandsArr !== undefined) && (CommandsArr.length >= 1)) {
        await this.tcpSocket?.modifyPanelConfig(CommandsArr)
      }
      this.watchDog()
      // Finally, Communication is ready
      this.emit('PanelCommReady', this.panelInfo)
    })

    // this.tcpSocket.on('IncomingRemoteConnection', () => {
    //   logger.log('debug', `Start of remote connection detected.`)
    //   if (this.watchDogTimer !== undefined) {
    //     clearTimeout(this.watchDogTimer)
    //   }
    // })
    //
    // this.tcpSocket.on('EndIncomingRemoteConnection', () => {
    //   logger.log('debug', `Remote connection end detected.`)
    //   if (this.tcpSocket?.isSocketConnected) {
    //     this.watchDog()
    //   }
    // })

    await this.tcpSocket.connect()
  }

  /*
   * Compare Received data with different (and possible) value
   * @param {string}
   */
  async dataFromPanel(cmdId: number | null, data: string) {
    logger.log('verbose', `Command[${cmdId}] Received data from panel: ${data}`)
    switch (true) {
      case (data.includes('ACK')):
        break
      case (data.startsWith('N')):
      case (data.startsWith('B')): {
        const loglevel = (this.tcpSocket?.inCryptTest || this.tcpSocket?.inPasswordGuess) ? 'debug' : 'warn'
        if ((Object.keys(RiscoError)).includes(data)) {
          logger.log(loglevel, `Command[${cmdId}] Receipt of an error code: ${RiscoError[data]}`)
        } else {
          logger.log(loglevel, `Command[${cmdId}] Data incomprehensible: ${data}`)
        }
        break
      }
      case (data.startsWith('OSTT')):
        logger.log('debug', `Command[${cmdId}] Data type: Output Status`)
        this.emit('NewOutputStatusFromPanel', data)
        break
      case (data.startsWith('PSTT')):
        logger.log('debug', `Command[${cmdId}] Data type: Partition Status`)
        this.emit('NewPartitionStatusFromPanel', data)
        break
      case (data.startsWith('SSTT')):
        logger.log('debug', `Command[${cmdId}] Data type: System Status`)
        if (this.tcpSocket?.inProg && !data.includes('I')) {
          this.tcpSocket.inProg = false
          logger.log('debug', `Command[${cmdId}] Control unit exiting Programming mode.`)
        }
        this.emit('NewMBSystemStatusFromPanel', data)
        break
      case (data.startsWith('ZSTT')):
        logger.log('debug', `Command[${cmdId}] Data type: Zone Status`)
        this.emit('NewZoneStatusFromPanel', data)
        break
      case (data.startsWith('CLOCK')):
        logger.log('debug', `Command[${cmdId}] Data type: Clock`)
        this.emit('Clock', data)
        break
      case (data.includes('STT')):
        // for hardware state (Keypad, Zone Extension, ....)
        logger.log('debug', `Command[${cmdId}] Data type: Hardware Status`)
        break
    }
  }

  /*
   *  For debug only
   */
  async DataFromPlugin(data: string, Sequence_Id: number) {
    logger.log('debug', `Command[${Sequence_Id}] Data Sent : ${data}`)
  }

  /*
   * Retrieve and store the panel type
   */
  async GetPanel_Type(): Promise<string> {
    assertIsDefined(this.tcpSocket, 'tcpSocket')
    let PType = undefined
    do {
      PType = await this.tcpSocket.getResult('PNLCNF')
    } while (PType === undefined)
    return PType
  }

  async applyPanelOptions(panelType: string): Promise<PanelInfo> {
    const firmwareVersion = await this.GetPanelFwVersion(panelType)
    switch (panelType) {
      case PanelType.RW132:
        return {
          PanelType: panelType,
          PanelModel: 'Agility',
          PanelFW: firmwareVersion,
          MaxZones: 36,
          MaxParts: 3,
          MaxOutputs: 4,
          SupportPirCam: false
        }
      case PanelType.RW232:
        return {
          PanelType: panelType,
          PanelModel: 'WiComm',
          PanelFW: firmwareVersion,
          MaxZones: 36,
          MaxParts: 3,
          MaxOutputs: 4,
          SupportPirCam: false
        }
      case PanelType.RW332:
        return {
          PanelType: panelType,
          PanelModel: 'WiCommPro',
          PanelFW: firmwareVersion,
          MaxZones: 36,
          MaxParts: 3,
          MaxOutputs: 4,
          SupportPirCam: false
        }
      case PanelType.RP432: {
        let MaxZones = 32
        let MaxOutputs = 14
        if (this.compareVersion(firmwareVersion, '3.0') >= 0) {
          MaxZones = 50
          MaxOutputs = 32
        }
        return {
          PanelType: panelType,
          PanelModel: 'LightSys',
          PanelFW: firmwareVersion,
          MaxZones: MaxZones,
          MaxParts: 4,
          MaxOutputs: MaxOutputs,
          SupportPirCam: false
        }
      }
      case PanelType.RP512: {
        let MaxZones = 64
        // At the moment, only zones up to 128.
        // This plugin does not currently manage zones requiring the activation of a license.
        if (this.compareVersion(firmwareVersion, '1.2.0.7') >= 0) {
          MaxZones = 128
        }

        let SupportPirCam: boolean
        if (this.compareVersion(firmwareVersion, '1.4.0.0') >= 0) {
          logger.log('verbose', 'PirCam not supported for now.')
          SupportPirCam = false
        } else {
          logger.log('verbose', 'PirCam not supported for now (Too Low Firmware version).')
          SupportPirCam = false
        }

        return {
          PanelType: panelType,
          PanelModel: 'ProsysPlus|GTPlus',
          PanelFW: firmwareVersion,
          MaxZones: MaxZones,
          MaxParts: 32,
          MaxOutputs: 262,
          SupportPirCam: SupportPirCam
        }

      }
      default:
        throw new Error(`Unsupported panel type : ${panelType}`)
    }
  }

  /*
   * Retrieve the version of Panel (only for LightSys and Prosys Plus)
   * This information is needed to set the hardware limits that have
   * been changed from some firmware versions.
   */
  async GetPanelFwVersion(panelType: string): Promise<string> {
    assertIsDefined(this.tcpSocket, 'tcpSocket')
    if (panelType === PanelType.RP432 || panelType === PanelType.RP512) {
      let FwVersion = ''
      try {
        FwVersion = await this.tcpSocket.getResult('FSVER?')
        FwVersion = FwVersion.substring(0, FwVersion.indexOf(' '))
      } catch (err) {
        logger.log('error', `Cannot retrieve Firmware Version.`)
      }
      FwVersion = FwVersion ? FwVersion : 'Undetermined'
      logger.log('debug', `Panel Firmware Version : ${FwVersion}`)
      return FwVersion
    }
    return 'N/A'
  }

  /*
   * Checks if the panel programming needs to be changed according to the options selected
   * @return  {Array of String}     String Command to be send to the Panel
   */
  async verifyPanelConfiguration(): Promise<string[]> {
    assertIsDefined(this.tcpSocket, 'tcpSocket')
    // Check the programming of the Risco Cloud according to the deactivation parameters
    const CommandArray = []
    logger.log('debug', `Checking the configuration of the control unit.`)

    if (this.disableRC && !this.enableRC) {

      // Disabling RiscoCloud can lead to a time desynchronization if the control panel time
      // zone is not correctly configured (when the riscoCloud is configured, it is it
      // which keeps the system on time).
      const RCloudStatus = await this.tcpSocket.getIntResult('ELASEN?')
      if (RCloudStatus) {
        CommandArray.push('ELASEN=0')
        logger.log('debug', `Prepare Panel for Disabling RiscoCloud.`)
      }
      // Check if the time zone is correctly configured
      const PanelTZ = await this.tcpSocket.getIntResult('TIMEZONE?')
      const PanelNtpServer = await this.tcpSocket.getResult('INTP?')
      const PanelNtpPort = await this.tcpSocket.getIntResult('INTPP?')
      const PanelNtpProto = await this.tcpSocket.getResult('INTPPROT?')

      if (TimeZoneStr[PanelTZ] !== this.GMT_TZ) {
        const newPanelTZ = Object.keys(TimeZoneStr).find(key => TimeZoneStr[parseInt(key, 10)] === this.GMT_TZ)
        CommandArray.push(`TIMEZONE=${newPanelTZ}`)
        logger.log('debug', `Prepare Panel for Updating TimeZone.`)
      }
      if (PanelNtpServer !== this.ntpServer) {
        CommandArray.push(`INTP=${this.ntpServer}`)
        logger.log('debug', `Prepare Panel for Updating NTP Server Address.`)
      }
      if (PanelNtpPort !== this.ntpPort) {
        CommandArray.push(`INTPP=${this.ntpPort}`)
        logger.log('debug', `Prepare Panel for Updating NTP Server Port.`)
      }
      if (PanelNtpProto !== '1') {
        CommandArray.push('INTPPROT=1')
        logger.log('debug', `Prepare Panel for Enabling Server.`)
      }
    } else if (this.enableRC && !this.disableRC) {
      // Enabling RiscoCloud
      const RCloudStatus = await this.tcpSocket.getIntResult('ELASEN?')
      if (!RCloudStatus) {
        CommandArray.push('ELASEN=1')
        logger.log('debug', `Enabling RiscoCloud.`)
      }
    }

    // if ((this.panelInfo?.PanelType !== PanelType.RP432) && (this.Panel_Type !== PanelType.RP512) && (this.SupportPirCam)) {
    //   //Check 'Photo Server' Config
    // }
    return CommandArray
  }

  /*
   * Version comparison function
   * @param   {String}      vPanel (Panel version Number)
   * @param   {String}      vNewCapacity (version unlocking new features)
   */
  private compareVersion(vPanel: string, vNewCapacity: string): number {
    if (vPanel === vNewCapacity) {
      return 0
    }
    const vPanel_components = vPanel.split('.')
    const vNewCapacity_components = vNewCapacity.split('.')
    const len = Math.min(vPanel_components.length, vNewCapacity_components.length)

    // loop while the components are equal
    for (let i = 0; i < len; i++) {
      // A bigger than B
      if (parseInt(vPanel_components[i]) > parseInt(vNewCapacity_components[i])) {
        return 1
      }
      // B bigger than A
      if (parseInt(vPanel_components[i]) < parseInt(vNewCapacity_components[i])) {
        return -1
      }
    }
    return 0
  }

  /*
   * Causes the TCP socket to disconnect
   */
  async disconnect() {
    this.isDisconnecting = true
    if (this.tcpSocket && this.tcpSocket.isPanelSocketConnected) {
      await this.tcpSocket.disconnect(false)
    }
  }

  /*
   * function alias to the function of the same name included
   * in the class Risco_DirectTCP_Socket
   */
  async disableRiscoCloud() {
    assertIsDefined(this.tcpSocket, 'tcpSocket')
    if (this.disableRC) {
      await this.tcpSocket.updateRiscoCloud(false)
    } else {
      logger.log('debug', `Disabling RiscoCloud functionality is not allowed.`)
    }
  }

  /*
   * function alias to the function of the same name included
   * in the class Risco_DirectTCP_Socket
   */
  async enableRiscoCloud() {
    assertIsDefined(this.tcpSocket, 'tcpSocket')
    if (this.enableRC) {
      await this.tcpSocket.updateRiscoCloud(true)
    } else {
      logger.log('debug', `Enabling RiscoCloud functionality is not allowed.`)
    }
  }

  /*
   * Queries the panel to retrieve information for all zones
   * @param   {zones}    ZoneList Object     Empty Object
   * @return  {zones}    ZoneList Object     Populated Object or new Object if fails
   */
  async GetAllZonesData(): Promise<ZoneList> {
    assertIsDefined(this.tcpSocket, 'tcpSocket')
    assertIsDefined(this.panelInfo, 'panelInfo')
    logger.log('debug', `Retrieving the configuration of the Zones.`)
    const zones = new ZoneList(this.panelInfo.MaxZones, this)
    const MaxZ = this.panelInfo.MaxZones
    for (let i = 0; i < (MaxZ / 8); i++) {
      const min = (i * 8) + 1
      let max = ((i + 1) * 8)
      max = (max > MaxZ) ? MaxZ : max

      const ZTypeResult = await this.tcpSocket.getResult(`ZTYPE*${min}:${max}?`)
      const ZType = ZTypeResult.replace(/ /g, '').split('\t')
      const ZPartsResult = await this.tcpSocket.getResult(`ZPART&*${min}:${max}?`)
      const ZParts = ZPartsResult.replace(/ /g, '').split('\t')
      const ZGroupsResult = await this.tcpSocket.getResult(`ZAREA&*${min}:${max}?`)
      const ZGroups = ZGroupsResult.replace(/ /g, '').split('\t')
      const ZLabelsResult = await this.tcpSocket.getResult(`ZLBL*${min}:${max}?`)
      const ZLabels = ZLabelsResult.split('\t')
      const ZStatusResult = await this.tcpSocket.getResult(`ZSTT*${min}:${max}?`)
      const ZStatus = ZStatusResult.replace(/ /g, '').split('\t')
      const ZTechno = new Array(max - min + 1).fill(0)
      for (let j = 0; j < (max - min + 1); j++) {
        ZTechno[j] = await this.tcpSocket.getResult(`ZLNKTYP${min + j}?`)
      }

      for (let j = 0; j < (max - min + 1); j++) {
        const Item = zones.byId(min + j)
        Item.Id = min + j
        Item.Label = ZLabels[j].trim()
        Item.Type = parseInt(ZType[j], 10)
        Item.Techno = ZTechno[j]
        Item.setPartsFromString(ZParts[j])
        Item.setGroupsFromString(ZGroups[j])
        Item.Status = ZStatus[j]
      }
    }
    return zones
  }

  /*
   * Queries the panel to retrieve up to date information for specified zone
   * @param   {Integer}     Zone Id           Id of the Selected Zone
   * @param   {ZoneList}    ZoneList Object
   * @return  {Zones}       Zone Object       Object representing the Zone
   */
  async getZoneStatus(id: number, zones: ZoneList): Promise<Zone> {
    logger.log('debug', `Retrieving the zone's status.`)
    assertIsDefined(this.tcpSocket, 'tcpSocket')
    const ZType = parseInt(await this.tcpSocket.getResult(`ZTYPE*${id}?`), 10)
    const ZParts = await this.tcpSocket.getResult(`ZPART&*${id}?`)
    const ZGroups = await this.tcpSocket.getResult(`ZAREA&*${id}?`)
    const ZLabels = await this.tcpSocket.getResult(`ZLBL*${id}?`)
    const ZStatus = await this.tcpSocket.getResult(`ZSTT*${id}?`)
    let ZTechno = await this.tcpSocket.getResult(`ZLNKTYP${id}?`)
    //TODO: use constants.RiscoError
    ZTechno = (!ZTechno.startsWith('N')) ? ZTechno : 'E'

    const Item = zones.byId(id)
    Item.Label = ZLabels.trim()
    Item.Type = ZType
    Item.Techno = ZTechno
    Item.setPartsFromString(ZParts)
    Item.setGroupsFromString(ZGroups)
    Item.Status = ZStatus
    return Item
  }

  /*
   * Queries the panel to retrieve information from all outputs
   * @param   {OutputList}    OutputList Object     Empty Object
   * @return  {OutputList}    OutputList Object     Populated Object or new Object if fails
   */
  async getAllOutputsData(): Promise<OutputList> {
    assertIsDefined(this.tcpSocket, 'tcpSocket')
    assertIsDefined(this.panelInfo, 'panelInfo')
    logger.log('debug', `Retrieving the configuration of the Outputs.`)
    const outputs = new OutputList(this.panelInfo.MaxOutputs, this)
    const MaxO = this.panelInfo.MaxOutputs
    const groups = true
    if (groups) {
      for (let i = 0; i < (MaxO / 8); i++) {
        const min = (i * 8) + 1
        let max = ((i + 1) * 8)
        max = (max > MaxO) ? MaxO : max

        const OStatusResult = await this.tcpSocket.getResult(`OSTT*${min}:${max}?`)
        const statusError = this.tcpSocket.getErrorCode(OStatusResult)
        if (statusError && statusError[0]) {
          if (statusError[0] === 'N19') {
            logger.log('info', 'Output does not exists, stopping outputs discovery')
            break
          } else {
            logger.log('warn', 'Unexpected output status error')
            continue
          }
        }

        const OTypeResult = await this.tcpSocket.getResult(`OTYPE*${min}:${max}?`)
        const OType = OTypeResult.replace(/ /g, '').split('\t').map(it => parseInt(it, 10))
        const OLabelsResult = await this.tcpSocket.getResult(`OLBL*${min}:${max}?`)
        const OLabels = OLabelsResult.split('\t')
        const OStatus = OStatusResult.replace(/ /g, '').split('\t')
        const OGropsResult = await this.tcpSocket.getResult(`OGROP*${min}:${max}?`)
        const OGrops = OGropsResult.replace(/ /g, '').split('\t')
        for (let j = 0; j < (max - min + 1); j++) {
          const Item = outputs.byId(min + j)
          Item.Id = min + j
          Item.Label = OLabels[j].trim()
          Item.Type = OType[j]
          if (Item.Pulsed) {
            const OPulseDelay = await this.tcpSocket.getResult(`OPULSE${min + j}?`)
            Item.PulseDelay = parseInt(OPulseDelay.replace(/ /g, ''), 10) * 1000
          } else {
            Item.PulseDelay = 0
          }
          Item.Status = OStatus[j]
          Item.UserUsable = OGrops[j] === '4'
        }
      }
    } else {
      for (let i = 1; i <= this.panelInfo.MaxOutputs; i++) {
        await this.getOutputStatus(i, outputs);
      }

    }
    return outputs
  }

  /*
   * Queries the panel to retrieve information for specified output
   * @param   {Integer}     Output Id         Id of the Selected Output
   * @param   {OutputList}  OutputList Object
   * @return  {Output}      Output Object     Object representing the Output
   */
  async getOutputStatus(id: number, outputs: OutputList): Promise<Output> {
    assertIsDefined(this.tcpSocket, 'tcpSocket')
    logger.log('debug', `Retrieving the Output's status.`)
    const OType = await this.tcpSocket.getResult(`OTYPE${id}?`)
    const OLabels = await this.tcpSocket.getResult(`OLBL${id}?`)
    const OGrops = await this.tcpSocket.getResult(`OGROP${id}?`)
    const OStatus = await this.tcpSocket.getResult(`OSTT${id}?`)

    const output = outputs.byId(id)
    output.Label = OLabels.trim()
    output.Type = parseInt(OType, 10)
    output.Status = OStatus
    if (output.Pulsed) {
      const OPulseDelay = await this.tcpSocket.getResult(`OPULSE${id}?`)
      output.PulseDelay = parseInt(OPulseDelay.replace(/ /g, ''), 10) * 1000
    } else {
      output.PulseDelay = 0
    }
    output.UserUsable = OGrops === '4'
    return output
  }

  /*
   * Queries the panel to retrieve information from all Partition
   * @param   {PartitionsList}    PartitionsList Object     Empty Object
   * @return  {PartitionsList}    PartitionsList Object     Populated Object or new Object if fails
   */
  async getAllPartitionsData(): Promise<PartitionList> {
    assertIsDefined(this.tcpSocket, 'tcpSocket')
    assertIsDefined(this.panelInfo, 'panelInfo')
    logger.log('debug', `Retrieving the configuration of the Partitions.`)
    const partitions = new PartitionList(this.panelInfo.MaxParts, this)
    const MaxP = this.panelInfo.MaxParts
    for (let i = 0; i < (MaxP / 8); i++) {
      const min = (i * 8) + 1
      let max = ((i + 1) * 8)
      max = (max > MaxP) ? MaxP : max

      const PLabelsResult = await this.tcpSocket.getResult(`PLBL*${min}:${max}?`)
      const PLabels = PLabelsResult.split('\t')
      const PStatusResult = await this.tcpSocket.getResult(`PSTT*${min}:${max}?`)
      const PStatus = PStatusResult.replace(/ /g, '').split('\t')

      for (let j = 0; j < (max - min + 1); j++) {
        const Item = partitions.byId(min + j)
        Item.Id = min + j
        Item.Label = PLabels[j].trim()
        Item.Status = PStatus[j]
      }
    }
    return partitions
  }

  /*
   * Queries the panel to retrieve information for specified Partition
   * @param   {Integer}           Partition Id            Id of the Selected Partition
   * @param   {PartitionsList}    PartitionsList Object
   * @return  {Output}            Partition Object        Object representing the Partition
   */
  async getPartitionsStatus(id: number, partitions: PartitionList): Promise<Partition> {
    assertIsDefined(this.tcpSocket, 'tcpSocket')
    logger.log('debug', `Retrieving the Partition's status.`)
    const PLabels = await this.tcpSocket.getResult(`PLBL${id}?`)
    const PStatus = await this.tcpSocket.getResult(`PSTT${id}?`)

    const partition = partitions.byId(id)
    partition.Label = PLabels.trim()
    partition.Status = PStatus

    return partition
  }

  /*
   * Queries needed info for System Object
   * @return  {MBSystem}    MBSystem Object     Populated Object or new Object if fails
   */
  async getSystemData(): Promise<MBSystem> {
    assertIsDefined(this.tcpSocket, 'tcpSocket')
    logger.log('debug', `Retrieving System's Information.`)
    const SLabel = await this.tcpSocket.getResult(`SYSLBL?`)
    const SStatus = await this.tcpSocket.getResult(`SSTT?`)

    return new MBSystem(SLabel, SStatus)
  }

  /*
   * Send a request at a fixed delay to maintain the connection
   */
  watchDog() {
    this.watchDogTimer = setTimeout(async () => {
      if (this.tcpSocket?.isPanelSocketConnected) {
        this.watchDog()
        if (!this.tcpSocket.inProg) {
          await this.tcpSocket.sendCommand(`CLOCK`)
        }
      }
    }, this.watchDogInterval)
  }
}