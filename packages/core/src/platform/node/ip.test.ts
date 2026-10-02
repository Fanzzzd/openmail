import { isIP as nativeIsIP } from "node:net";
import { expect, it } from "vitest";
import { isIP } from "../ip.js";

it("rejects IPv4 groups before compression or another group", () => {
  for (const address of ["127.0.0.1::", "1:127.0.0.1::", "127.0.0.1::1", "::127.0.0.1:1"]) {
    expect(isIP(address), address).toBe(nativeIsIP(address));
  }
});
it("matches node:net for deterministic mutated and generated IP literals", () => {
  let seed = 0x390039;
  const random = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 2 ** 32) * max);
  };
  const zones = ["", "%eth0", "%a:b", "%foo-1", "%foo/bar", "%", "%eth_0", "%a%0"];
  const samples = new Set(["127.0.0.1::", "::", "::ffff:192.168.0.1", "1:2:3:4:5:6:192.168.0.1"]);
  for (let index = 0; index < 6000; index++) {
    const ipv4 = Array.from({ length: 4 }, () => String(random(300))).join(".");
    const groups = Array.from({ length: random(10) }, () => random(0x10000).toString(16));
    if (groups.length && random(2)) groups[random(groups.length)] = ipv4;
    const split = random(groups.length + 1);
    const address = random(2)
      ? `${groups.slice(0, split).join(":")}::${groups.slice(split).join(":")}`
      : groups.join(":");
    samples.add(address + zones[random(zones.length)]);
    samples.add(ipv4 + (random(2) ? "::" : ""));
    if (address) {
      const position = random(address.length);
      samples.add(
        address.slice(0, position) +
          [":", ".", "g", "00000", ""][random(5)] +
          address.slice(position + 1),
      );
    }
  }
  const mismatches = [...samples].filter((address) => isIP(address) !== nativeIsIP(address));
  expect(mismatches).toEqual([]);
});
