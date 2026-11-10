import { describe, expect, it } from "vitest";
import { parsePort } from "./port.js";

describe("parsePort", () => {
  it("accepts a usable TCP port", () => {
    expect(parsePort("47812")).toBe(47812);
    expect(parsePort(1)).toBe(1);
    expect(parsePort("65535")).toBe(65535);
  });

  it("treats an unset or empty value as 'inbox disabled'", () => {
    expect(parsePort(undefined)).toBeNull();
    expect(parsePort(null)).toBeNull();
    expect(parsePort("")).toBeNull();
  });

  it("rejects out-of-range and non-numeric values instead of letting listen() fail later", () => {
    expect(parsePort("0")).toBeNull();
    expect(parsePort("-1")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("abc")).toBeNull();
  });
});
