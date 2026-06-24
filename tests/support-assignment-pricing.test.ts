import { describe, expect, it } from "bun:test";

import { estimateSupportCostLocal } from "../src/modules/support/cost-estimation";

describe("support assignment pricing", () => {
  it("keeps assignment requests fixed at GHS 10", () => {
    const estimate = estimateSupportCostLocal({
      serviceCategory: "assignment",
      serviceTags: ["assignment"],
      budgetMin: 5,
      description: "Answer one assignment question.",
    });

    expect(estimate.range).toEqual({ min: 10, max: 10 });
    expect(estimate.counterOffer).toBe(10);
    expect(estimate.breakdown).toEqual([{ item: "One assignment", cost: 10 }]);
  });
});
