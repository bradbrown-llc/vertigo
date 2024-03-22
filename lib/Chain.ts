import { AIQ } from 'https://deno.land/x/aiq@0.0.0/mod.ts'
import { Ejra } from '../../../llc/ejra/lib/Ejra.ts'
import { Log } from '../../../llc/ejra/type/Log.ts'
import { TxCallObject } from '../../../llc/ejra/type/TxCallObject.ts'
import { Receipt } from '../../../llc/ejra/type/Receipt.ts'
import { KvVertigo } from '../../../llc/kv_vertigo/mod.ts'
import { KvFilter } from './KvFilter.ts'
import { Filter } from './Filter.ts'
import { KvChain } from './KvChain.ts'

type EconomyConfiguration = {
    gasLimitMultiplier:[numerator:bigint, denominator:bigint],
    gasPriceMultiplier:[numerator:bigint, denominator:bigint],
    baseFee:bigint,
}

export class Chain {

    chainId:bigint
    entry:Deno.KvEntry<KvChain>
    kvv:KvVertigo
    ejra:Ejra
    err?:AIQ<Error>
    out?:AIQ<string>

    constructor(entry:Deno.KvEntry<KvChain>, kvv:KvVertigo, ejra:Ejra, { err, out }:{ err?:AIQ<Error>, out?:AIQ<string> }={}) {
        this.chainId = entry.key[1] as bigint
        this.entry = entry
        this.kvv = kvv
        this.ejra = ejra
        this.out = out
        this.err = err
    }

    static async stalest(kvv:KvVertigo, ejra:Ejra, { err, out }:{ err?:AIQ<Error>, out?:AIQ<string> }={}):Promise<Chain|null> {
        let stale:Deno.KvEntry<KvChain>|undefined
        for await (const entry of kvv.list<KvChain>({ prefix: ['chains'] })) {
            if (entry instanceof Error) continue 
            if (!stale) stale = entry
            if (entry.value.lastUpdated < stale.value.lastUpdated) stale = entry
        }
        if (!stale) return null
        const chain = new Chain(stale, kvv, ejra, { err, out })
        await chain.update()
        return chain
    }

    async update():Promise<Error|boolean> {
        const kvChain:KvChain = { lastUpdated: Date.now() }
        const result = await this.kvv.atomic()
            .check(this.entry)
            .set(['chains', this.chainId], kvChain)
            .commit()
        return result instanceof Error ? result : result.ok
    }

    async logs(address:string, topics:(string|string[])[], processId:string):Promise<Error|Log[]> {
        const filter = await this.filter(address, topics, processId)
        if (filter instanceof Error) return filter
        if (filter.width < 1n) return []
        const logs = await this.ejra.logs(this.chainId, filter.toJSON())
        if (logs instanceof Error) filter.bisect()
        else filter.bump()
        await filter.update(processId)
        return logs
    }

    async filter(address:string, topics:(string|string[])[], processId:string):Promise<Error|Filter> {
        const entry = await this.kvv.get<KvFilter>(['filters', this.chainId, address, topics.sort((a, b) => a < b ? -1 : a == b ? 0 : 1).join(), processId])
        if (entry instanceof Error) return entry
        const filter:Filter = new Filter(entry, this, address, topics)
        if (filter.width > 0n) return filter
        const height = await this.height()
        if (height instanceof Error) return height
        filter.toBlock = height
        await filter.clip()
        return filter
    }

    async url():Promise<Error|string> {
        const url = await this.ejra.urls.get(this.chainId)?.get()
        if (url === undefined) return new Error(`url not set for chain ${this.chainId}`)
        return url
    }

    static async active(kvv:KvVertigo, chainId:bigint):Promise<Error|boolean> {
        const entry = await kvv.get<KvChain>(['chains', chainId])
        return entry instanceof Error ? entry : !!entry.versionstamp
    }

    async confirmations():Promise<Error|bigint> {
        const kvem = await this.kvv.get<bigint>(['confirmations', this.chainId])
        if (kvem instanceof Error) return kvem
        if (kvem.value === null) return new Error(`Chain.confirmations: no confirmations set for chain ${this.chainId}`)
        return kvem.value 
    }

    receipt(hash:string):Promise<Error|Receipt> {
        return this.ejra.receipt(this.chainId, hash)
    }

    height():Promise<Error|bigint> {
        return this.ejra.height(this.chainId)
    }

    send(data:string):Promise<Error|string> {
        return this.ejra.send(this.chainId, data)
    }

    estimateGas(txCallObject:Partial<TxCallObject>):Promise<Error|bigint> {
        return this.ejra.estimateGas(this.chainId, txCallObject)
    }

    gasPrice():Promise<Error|bigint> {
        return this.ejra.gasPrice(this.chainId)
    }

    async nonce():Promise<Error|bigint> {
        while (true) {
            const entry = await this.kvv.get<bigint>(['nonce', this.chainId])
            if (entry instanceof Error) return entry
            const nonce = entry.value ?? 0n
            const result = await this.kvv.atomic()
                .check(entry)
                .set(['nonce', this.chainId], nonce + 1n)
                .commit()
            if (result instanceof Error) return result
            if (result.ok === true) return nonce
        }
    }

    async economyConfiguration():Promise<Error|EconomyConfiguration> {
        const entry = await this.kvv.get<EconomyConfiguration>(['econConf', this.chainId])
        if (entry instanceof Error) return entry
        if (entry.value === null) return new Error(`Chain.economyConfiguration, unset econ conf for chain ${this.chainId}`)
        return entry.value
    }

}