import { Sha256 } from '@cosmjs/crypto';
import { fromBase64, fromUtf8, toBech32 } from '@cosmjs/encoding';
import {
  BasicBackendApi,
  BasicKVIterStorage,
  IBackend,
} from '@terran-one/cosmwasm-vm-js';
import { CWSimulateApp } from '../CWSimulateApp';
import { CWSimulateVMInstance } from '../instrumentation/CWSimulateVMInstance';

import {
  AppResponse,
  Binary,
  CodeInfo,
  Coin,
  ContractInfo,
  ContractInfoResponse,
  ContractResponse,
  Event,
  ExecuteEnv,
  ReplyMsg,
  ReplyOn,
  RustResult,
  SubMsg,
  TraceLog,
  ExecuteTraceLog,
  ReplyTraceLog,
  DebugLog,
} from '../types';
import { Map } from 'immutable';
import { Err, Ok, Result } from 'ts-results';
import { fromBinary, fromRustResult, toBinary } from '../util';

function numberToBigEndianUint64(n: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, n, false);
  view.setUint32(4, 0, false);
  return new Uint8Array(buffer);
}

export interface Execute {
  contract_addr: string;
  msg: string;
  funds: { denom: string; amount: string }[];
}

export interface Instantiate {
  admin: string | null;
  code_id: number;
  msg: string;
  funds: { denom: string; amount: string }[];
  label: string;
}

export interface SmartQuery {
  contract_addr: string;
  msg: string; // Binary
}

export interface RawQuery {
  contract_addr: string;
  key: string; // Binary
}

export interface ContractInfoQuery {
  contract_addr: string;
}

export type WasmMsg =
  | { execute: Execute }
  | { instantiate: Instantiate };

export type WasmQuery =
  | { smart: SmartQuery }
  | { raw: RawQuery }
  | { contract_info: ContractInfoQuery };

export class WasmModule {
  public lastCodeId: number;
  public lastInstanceId: number;
  
  // TODO: benchmark w/ many coexisting VMs
  private vms: Record<string, CWSimulateVMInstance> = {};

  constructor(public chain: CWSimulateApp) {
    chain.store.set('wasm', { codes: {}, contracts: {}, contractStorage: {} });

    this.lastCodeId = 0;
    this.lastInstanceId = 0;
  }

  static buildContractAddress(codeId: number, instanceId: number): Uint8Array {
    let contractId = new Uint8Array([
      ...numberToBigEndianUint64(codeId),
      ...numberToBigEndianUint64(instanceId),
    ]);

    // append module name
    let mKey = new Uint8Array([
      ...Uint8Array.from(Buffer.from('wasm', 'utf-8')),
      0,
    ]);
    let payload = new Uint8Array([...mKey, ...contractId]);

    let hasher = new Sha256();
    hasher.update(Buffer.from('module', 'utf-8'));
    let th = hasher.digest();
    hasher = new Sha256(th);
    hasher.update(payload);
    let hash = hasher.digest();
    return hash.slice(0, 20);
  }

  setContractStorage(contractAddress: string, value: Map<string, string>) {
    this.chain.store = this.chain.store.setIn(
      ['wasm', 'contractStorage', contractAddress],
      value
    );
  }

  getContractStorage(contractAddress: string) {
    const existing = this.chain.store.getIn([
      'wasm',
      'contractStorage',
      contractAddress,
    ]) as Map<string, string> | undefined;
    return existing ?? Map();
  }

  setCodeInfo(codeId: number, codeInfo: CodeInfo) {
    this.chain.store = this.chain.store.setIn(
      ['wasm', 'codes', codeId],
      codeInfo
    );
  }

  getCodeInfo(codeId: number): CodeInfo {
    return this.chain.store.getIn(['wasm', 'codes', codeId]) as CodeInfo;
  }

  setContractInfo(contractAddress: string, contractInfo: ContractInfo) {
    this.chain.store = this.chain.store.setIn(
      ['wasm', 'contracts', contractAddress],
      contractInfo
    );
  }

  getContractInfo(contractAddress: string) {
    return this.chain.store.getIn([
      'wasm',
      'contracts',
      contractAddress,
    ]) as ContractInfo | undefined;
  }

  deleteContractInfo(contractAddress: string) {
    this.chain.store = this.chain.store.deleteIn([
      'wasm',
      'contracts',
      contractAddress,
    ]);
  }

  create(creator: string, wasmCode: Uint8Array): number {
    let codeInfo = {
      creator,
      wasmCode,
    };

    this.setCodeInfo(this.lastCodeId + 1, codeInfo);
    this.lastCodeId += 1;
    return this.lastCodeId;
  }

  getExecutionEnv(contractAddress: string): ExecuteEnv {
    return {
      block: {
        height: this.chain.height,
        time: this.chain.time.toFixed(),
        chain_id: this.chain.chainId,
      },
      contract: {
        address: contractAddress,
      },
    };
  }

  async buildVM(contractAddress: string): Promise<CWSimulateVMInstance> {
    if (!(contractAddress in this.vms)) {
      const contractInfo = this.getContractInfo(contractAddress);
      if (!contractInfo)
        throw new Error(`contract ${contractAddress} not found`);

      const { codeId } = contractInfo;
      const codeInfo = this.getCodeInfo(codeId);
      if (!codeInfo)
        throw new Error(`code ${codeId} not found`);

      const { wasmCode } = codeInfo;
      const contractState = this.getContractStorage(contractAddress);

      let storage = new BasicKVIterStorage();
      storage.dict = contractState;

      let backend: IBackend = {
        backend_api: new BasicBackendApi(this.chain.bech32Prefix),
        storage,
        querier: this.chain.querier,
      };

      const logs: DebugLog[] = [];
      const vm = new CWSimulateVMInstance(logs, backend);
      await vm.build(wasmCode);
      this.vms[contractAddress] = vm;
    }
    return this.vms[contractAddress];
  }

  // TODO: add admin, label, etc.
  registerContractInstance(sender: string, codeId: number): string {
    const contractAddressHash = WasmModule.buildContractAddress(
      codeId,
      this.lastInstanceId + 1
    );

    const contractAddress = toBech32(
      this.chain.bech32Prefix,
      contractAddressHash
    );

    const contractInfo = {
      codeId,
      creator: sender,
      admin: null,
      label: '',
      created: this.chain.height,
    };

    this.setContractInfo(contractAddress, contractInfo);
    this.setContractStorage(contractAddress, Map<string, string>());

    this.lastInstanceId += 1;
    return contractAddress;
  }

  async callInstantiate(
    sender: string,
    funds: Coin[],
    contractAddress: string,
    instantiateMsg: any,
    logs: DebugLog[]
  ): Promise<RustResult<ContractResponse>> {
    let vm = await this.buildVM(contractAddress);
    let env = this.getExecutionEnv(contractAddress);
    let info = { sender, funds };

    let res = vm.instantiate(env, info, instantiateMsg)
      .json as RustResult<ContractResponse>;

    this.setContractStorage(
      contractAddress,
      (vm.backend.storage as BasicKVIterStorage).dict
    );

    logs.push(...vm.logs);

    return res;
  }

  async instantiateContract(
    sender: string,
    funds: Coin[],
    codeId: number,
    instantiateMsg: any,
    trace: TraceLog[] = []
  ): Promise<Result<AppResponse, string>> {
    // first register the contract instance
    let snapshot = this.chain.store;
    const contractAddress = this.registerContractInstance(sender, codeId);
    let logs = [] as DebugLog[];

    // then call instantiate
    let response = await this.callInstantiate(
      sender,
      funds,
      contractAddress,
      instantiateMsg,
      logs
    );

    if ('error' in response) {
      // revert the contract instance registration
      this.lastInstanceId -= 1;
      this.deleteContractInfo(contractAddress);
      this.chain.store = snapshot;
      let result = Err(response.error);
      trace.push({
        type: 'instantiate' as 'instantiate',
        contractAddress,
        msg: instantiateMsg,
        response,
        info: {
          sender,
          funds,
        },
        env: this.getExecutionEnv(contractAddress),
        logs,
        storeSnapshot: snapshot,
        result,
      });
      return result;
    } else {
      let customEvent: Event = {
        type: 'instantiate',
        attributes: [
          { key: '_contract_address', value: contractAddress },
          { key: 'code_id', value: codeId.toString() },
        ],
      };
      let res = this.buildAppResponse(
        contractAddress,
        customEvent,
        response.ok
      );

      let subtrace: TraceLog[] = [];

      let result = await this.handleContractResponse(
        contractAddress,
        response.ok.messages,
        res,
        subtrace
      );

      trace.push({
        type: 'instantiate' as 'instantiate',
        contractAddress,
        msg: instantiateMsg,
        response,
        info: {
          sender,
          funds,
        },
        env: this.getExecutionEnv(contractAddress),
        logs,
        trace: subtrace,
        storeSnapshot: this.chain.store,
        result,
      });

      return result;
    }
  }

  callExecute(
    sender: string,
    funds: Coin[],
    contractAddress: string,
    executeMsg: any,
    logs: DebugLog[],
  ): RustResult<ContractResponse> {
    let vm = this.vms[contractAddress];
    if (!vm) throw new Error(`No VM for contract ${contractAddress}`);
    vm.resetDebugInfo();

    let env = this.getExecutionEnv(contractAddress);
    let info = { sender, funds };

    let res = vm.execute(env, info, executeMsg)
      .json as RustResult<ContractResponse>;

    this.setContractStorage(
      contractAddress,
      (vm.backend.storage as BasicKVIterStorage).dict
    );

    logs.push(...vm.logs);

    return res;
  }

  async executeContract(
    sender: string,
    funds: Coin[],
    contractAddress: string,
    executeMsg: any,
    trace: TraceLog[] = []
  ): Promise<Result<AppResponse, string>> {
    let snapshot = this.chain.store;
    let logs: DebugLog[] = [];

    let response = this.callExecute(
      sender,
      funds,
      contractAddress,
      executeMsg,
      logs
    );
    
    if ('error' in response) {
      this.chain.store = snapshot; // revert
      let result = Err(response.error);
      trace.push({
        type: 'execute' as 'execute',
        contractAddress,
        msg: executeMsg,
        response,
        env: this.getExecutionEnv(contractAddress),
        info: {
          sender,
          funds,
        },
        logs,
        storeSnapshot: snapshot,
        result,
      });
      return result;
    } else {
      let customEvent = {
        type: 'execute',
        attributes: [
          {
            key: '_contract_addr',
            value: contractAddress,
          },
        ],
      };
      let res = this.buildAppResponse(
        contractAddress,
        customEvent,
        response.ok
      );
      let subtrace: TraceLog[] = [];
      let result = await this.handleContractResponse(
        contractAddress,
        response.ok.messages,
        res,
        subtrace
      );
      trace.push({
        type: 'execute' as 'execute',
        contractAddress,
        msg: executeMsg,
        response,
        info: {
          sender,
          funds,
        },
        env: this.getExecutionEnv(contractAddress),
        trace: subtrace,
        logs,
        storeSnapshot: this.chain.store,
        result,
      });
      return result;
    }
  }

  async handleContractResponse(
    contractAddress: string,
    messages: ContractResponse['messages'],
    res: AppResponse,
    trace: TraceLog[] = []
  ): Promise<Result<AppResponse, string>> {
    let snapshot = this.chain.store;
    for (const message of messages) {
      let subres = await this.executeSubmsg(contractAddress, message, trace);
      if (subres.err) {
        this.chain.store = snapshot; // revert
        return subres;
      } else {
        res.events = [...res.events, ...subres.val.events];
        if (subres.val.data !== null) {
          res.data = subres.val.data;
        }
      }
    }

    return Ok({ events: res.events, data: res.data });
  }

  async executeSubmsg(
    contractAddress: string,
    message: SubMsg,
    trace: TraceLog[] = []
  ): Promise<Result<AppResponse, string>> {
    let { id, msg, gas_limit, reply_on } = message;
    let r = await this.chain.handleMsg(contractAddress, msg, trace);
    if (r.ok) {
      // submessage success
      let { events, data } = r.val;
      if (reply_on === ReplyOn.Success || reply_on === ReplyOn.Always) {
        // submessage success, call reply
        let replyMsg: ReplyMsg = {
          id,
          result: {
            ok: {
              events,
              data,
            },
          },
        };
        let replyRes = await this.reply(contractAddress, replyMsg, trace);
        if (replyRes.err) {
          // submessage success, call reply, reply failed
          return replyRes;
        } else {
          // submessage success, call reply, reply success
          if (replyRes.val.data !== null) {
            data = replyRes.val.data;
          }
          events = [...events, ...replyRes.val.events];
        }
      } else {
        // submessage success, don't call reply
        data = null;
      }
      return Ok({ events, data });
    } else {
      // submessage failed
      if (reply_on === ReplyOn.Error || reply_on === ReplyOn.Always) {
        // submessage failed, call reply
        let replyMsg: ReplyMsg = {
          id,
          result: {
            error: r.val,
          },
        };
        let replyRes = await this.reply(contractAddress, replyMsg, trace);
        if (replyRes.err) {
          // submessage failed, call reply, reply failed
          return replyRes;
        } else {
          // submessage failed, call reply, reply success
          let { events, data } = replyRes.val;
          return Ok({ events, data });
        }
      } else {
        // submessage failed, don't call reply (equivalent to normal message)
        return r;
      }
    }
  }

  callReply(
    contractAddress: string,
    replyMsg: ReplyMsg,
    logs: DebugLog[],
  ): RustResult<ContractResponse> {
    let vm = this.vms[contractAddress];
    if (!vm) throw new Error(`No VM for contract ${contractAddress}`);
    
    let res = vm.reply(this.getExecutionEnv(contractAddress), replyMsg)
      .json as RustResult<ContractResponse>;

    this.setContractStorage(
      contractAddress,
      (vm.backend.storage as BasicKVIterStorage).dict
    );

    logs.push(...vm.logs);

    return res;
  }

  async reply(
    contractAddress: string,
    replyMsg: ReplyMsg,
    trace: TraceLog[] = []
  ): Promise<Result<AppResponse, string>> {
    let logs: DebugLog[] = [];
    let response = this.callReply(contractAddress, replyMsg, logs);
    if ('error' in response) {
      let result = Err(response.error);
      trace.push({
        type: 'reply' as 'reply',
        contractAddress,
        env: this.getExecutionEnv(contractAddress),
        msg: replyMsg,
        response,
        logs,
        storeSnapshot: this.chain.store,
        result,
      });
      return result;
    } else {
      let customEvent = {
        type: 'reply',
        attributes: [
          {
            key: '_contract_addr',
            value: contractAddress,
          },
          {
            key: 'mode',
            value:
              'ok' in replyMsg.result ? 'handle_success' : 'handle_failure',
          },
        ],
      };
      let res = this.buildAppResponse(
        contractAddress,
        customEvent,
        response.ok
      );
      let subtrace: TraceLog[] = [];
      let result = await this.handleContractResponse(
        contractAddress,
        response.ok.messages,
        res,
        subtrace
      );
      trace.push({
        type: 'reply' as 'reply',
        contractAddress,
        msg: replyMsg,
        env: this.getExecutionEnv(contractAddress),
        response,
        trace: subtrace,
        logs,
        storeSnapshot: this.chain.store,
        result,
      });
      return result;
    }
  }

  query(
    contractAddress: string,
    queryMsg: any
  ): Result<any, string> {
    let vm = this.vms[contractAddress];
    if (!vm) throw new Error(`No VM for contract ${contractAddress}`);
    
    let env = this.getExecutionEnv(contractAddress);
    return fromRustResult(vm.query(env, queryMsg).json as RustResult<string>)
      .andThen(v => Ok(fromBinary(v)));
  }

  buildAppResponse(
    contract: string,
    customEvent: Event,
    response: ContractResponse
  ): AppResponse {
    let appEvents = [];
    // add custom event
    appEvents.push(customEvent);

    // add contract attributes under `wasm` event type
    if (response.attributes.length > 0) {
      appEvents.push({
        type: 'wasm',
        attributes: [
          {
            key: '_contract_addr',
            value: contract,
          },
          ...response.attributes,
        ],
      });
    }

    // add events and prefix with `wasm-`
    for (const event of response.events) {
      appEvents.push({
        type: `wasm-${event.type}`,
        attributes: [
          { key: '_contract_addr', value: contract },
          ...event.attributes,
        ],
      });
    }

    return {
      events: appEvents,
      data: response.data,
    };
  }

  async handleMsg(
    sender: string,
    msg: WasmMsg,
    trace: TraceLog[] = []
  ): Promise<Result<AppResponse, string>> {
    let wasm = msg;
    if ('execute' in wasm) {
      let { contract_addr, funds, msg } = wasm.execute;
      return await this.executeContract(
        sender,
        funds,
        contract_addr,
        fromBinary(msg),
        trace
      );
    }
    else if ('instantiate' in wasm) {
      let { code_id, funds, msg } = wasm.instantiate;
      return await this.instantiateContract(
        sender,
        funds,
        code_id,
        fromBinary(msg),
        trace,
      );
    }
    else {
      throw new Error('Unknown wasm message');
    }
  }

  handleQuery(query: WasmQuery): Result<Binary, string> {
    if ('smart' in query) {
      const { contract_addr, msg } = query.smart;
      return Ok(
        toBinary(this.query(contract_addr, fromBinary(msg)))
      );
    }
    else if ('raw' in query) {
      const { contract_addr, key } = query.raw;
      
      const storage = this.getContractStorage(contract_addr);
      if (!storage) {
        return Err(`Contract ${contract_addr} not found`);
      }
      
      const value = storage.get(key);
      if (value === undefined) {
        return Err(`Key ${key} not found`);
      }
      else {
        return Ok(value);
      }
    }
    else if ('contract_info' in query) {
      const { contract_addr } = query.contract_info;
      const info = this.getContractInfo(contract_addr);
      if (info === undefined) {
        return Err(`Contract ${contract_addr} not found`);
      }
      else {
        const { codeId: code_id, creator, admin } = info;
        const resp: ContractInfoResponse = {
          code_id,
          creator,
          admin,
          ibc_port: null,
          // TODO: VM lifetime mgmt
          // currently all VMs are always loaded ie pinned
          pinned: true,
        };
        
        return Ok(toBinary(resp));
      }
    }
    else {
      return Err('Unknown wasm query');
    }
  }
}
