import { describe, expect, it } from "vitest";
import { OMNI_FAILURE_STOP_AFTER, omniFailureStopReason } from "./omni-failure-stop";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 8, minute)).toISOString();
const job = (state: string, minute: number) => ({ state, finished_at: at(minute) });

describe("OMNI two-failure stop", () => {
  it("stops after 2 failures", () => {
    expect(OMNI_FAILURE_STOP_AFTER).toBe(2);
  });
  it("allows a job after 0 or 1 failures", () => {
    expect(omniFailureStopReason({ since: null, jobs: [] })).toBeNull();
    expect(omniFailureStopReason({ since: null, jobs: [job("failed", 5)] })).toBeNull();
  });
  it("refuses after 2 failures in a row", () => {
    expect(
      omniFailureStopReason({ since: null, jobs: [job("failed", 5), job("failed", 6)] }),
    ).toBe("failure_stop");
  });
  it("a completed job between failures resets the run", () => {
    expect(
      omniFailureStopReason({
        since: null,
        jobs: [job("failed", 1), job("completed", 2), job("failed", 3)],
      }),
    ).toBeNull();
  });
  it("cancelled jobs do not reset two failures", () => {
    expect(
      omniFailureStopReason({
        since: null,
        jobs: [job("failed", 1), job("cancelled", 2), job("failed", 3)],
      }),
    ).toBe("failure_stop");
  });
  it("a new owner authorization is the reset point", () => {
    const jobs = [job("failed", 1), job("failed", 2)];
    expect(omniFailureStopReason({ since: at(3), jobs })).toBeNull();
    expect(omniFailureStopReason({ since: at(1), jobs })).toBeNull();
    expect(omniFailureStopReason({ since: at(0), jobs })).toBe("failure_stop");
  });
  it("orders by finish time, not by list order", () => {
    expect(
      omniFailureStopReason({
        since: null,
        jobs: [job("failed", 9), job("completed", 1), job("failed", 8)],
      }),
    ).toBe("failure_stop");
  });
  it("fails closed when the history cannot be read or ordered", () => {
    expect(omniFailureStopReason(null)).toBe("failure_stop_unreadable");
    expect(omniFailureStopReason({ since: "garbage", jobs: [] })).toBe("failure_stop_unreadable");
    expect(
      omniFailureStopReason({ since: null, jobs: [{ state: "failed", finished_at: null }] }),
    ).toBe("failure_stop_unreadable");
  });
});
