import { describe, it, expect } from "vitest";
import { bookingRecordId } from "../concierge/types";

describe("bookingRecordId", () => {
  it("is deterministic and unique per (trip,item,rail)", () => {
    expect(bookingRecordId("t1", "i1", "mock")).toBe("t1:i1:mock");
    expect(bookingRecordId("t1", "i1", "mock")).toBe(bookingRecordId("t1", "i1", "mock"));
    expect(bookingRecordId("t1", "i2", "mock")).not.toBe(bookingRecordId("t1", "i1", "mock"));
  });
});
