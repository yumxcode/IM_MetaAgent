import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAccountHealth } from '../src/account-health.mjs';
import { WeixinApiError, WeixinHttpError, WeixinTimeoutError, WeixinNetworkError } from '../src/http.mjs';
const account={baseUrl:'https://ilinkai.weixin.qq.com',token:'test-token',userId:'peer',timeoutMs:4000};
test('healthy probe uses getConfig without consuming messages',async()=>{
 let observed; const result=await checkAccountHealth(account,async opts=>{observed=opts;return {ret:0};});
 assert.equal(result.result,'valid');assert.equal(observed.ilinkUserId,'peer');assert.equal(observed.getUpdatesBuf,undefined);
});
test('missing token makes no network request',async()=>assert.equal((await checkAccountHealth({},()=>{throw Error('must not call');})).result,'invalid'));
for(const [name,error,result] of [
 ['errcode expiration',new WeixinApiError('stale',{errcode:-14}),'expired'],
 ['ret expiration',new WeixinApiError('stale',{ret:-14}),'expired'],
 ['Typing RPC error',new WeixinApiError('GetTypingTicket rpc failed',{ret:-4}),'unknown'],
 ['timeout',new WeixinTimeoutError('timeout'),'unknown'],
 ['HTTP authentication rejection',new WeixinHttpError('unauthorized',{status:401}),'invalid'],
 ['HTTP service failure',new WeixinHttpError('unavailable',{status:503}),'unknown'],
 ['network error',new WeixinNetworkError('DNS error'),'network_error'],
]) test(name,async()=>assert.equal((await checkAccountHealth(account,async()=>{throw error;})).result,result));
