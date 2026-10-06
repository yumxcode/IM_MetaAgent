import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonLossless, parseWeixinApiJson } from "../src/json.mjs";

test("uint64 message IDs survive round trip exactly, ordinary numbers stay numeric", () => {
  const result = parseJsonLossless('{"ret":0,"message_id":18446744073709551615,"msgs":[{"message_id":9007199254740993,"item_list":[{"msg_id":42,"ref_msg":{"svr_id":18446744073709551614}}]}],"create_time_ms":1234567890123,"count":123,"fraction":1.25}');
  assert.equal(result.message_id, "18446744073709551615");
  assert.equal(result.msgs[0].message_id, "9007199254740993");
  assert.equal(result.msgs[0].item_list[0].msg_id, "42");
  assert.equal(result.msgs[0].item_list[0].ref_msg.svr_id, "18446744073709551614");
  assert.equal(result.ret, 0);
  assert.equal(result.create_time_ms, 1234567890123);
  assert.equal(result.count, 123);
  assert.equal(result.fraction, 1.25);
  assert.equal(parseWeixinApiJson, parseJsonLossless);
});

test("quoted JSON-like text, escaped quotes and prequoted IDs stay unchanged", () => {
  const source = { text: 'quote: "message_id":18446744073709551615 \\ escaped', message_id: "18446744073709551615", arr: ["msg_id", "svr_id"] };
  assert.deepEqual(parseJsonLossless(JSON.stringify(source)), source);
});

test("escaped property names and whitespace are parsed losslessly", () => {
  assert.deepEqual(parseJsonLossless('{ "message_\\u0069d" : 18446744073709551615 , "svr_id":0, "msg_id":-1}'), { message_id: "18446744073709551615", svr_id: "0", msg_id: "-1" });
});

test("fractional/exponent values are not mistaken for integer prefixes", () => {
  assert.deepEqual(parseJsonLossless('{"msg_id":1.5,"svr_id":1e3,"message_id":-2.5}'), { msg_id: 1.5, svr_id: 1000, message_id: -2.5 });
});

test("malformed JSON still fails instead of being repaired", () => {
  for (const source of ['{"message_id":01}', '{"message_id":1abc}', '{"message_id":1', '{"text":"unfinished}']) {
    assert.throws(() => parseJsonLossless(source), SyntaxError);
  }
});
