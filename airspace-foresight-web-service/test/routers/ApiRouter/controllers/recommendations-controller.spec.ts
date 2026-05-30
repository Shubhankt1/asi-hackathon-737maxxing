import { describe, it, before } from "node:test";
import { request, assertOk, assertError } from "@swizzyweb/swizzy-web-service-test-framework";
import { createAirspaceForesightTestApp } from "../../../helpers/create-airspace-foresight-test-app.js";

describe("RecommendationsControllerController", () => {
  let app: any;

  before(async () => {
    ({ app } = await createAirspaceForesightTestApp());
  });

  it("GET /api/recommendations returns 200", async () => {
    const res = await request(app).get("/api/recommendations");
    assertOk(res);
  });

  it("GET /api/recommendations returns 500 when an error occurs", async () => {
    // TODO: override a state dependency to throw and verify the 500 response.
    // const { app: errApp } = await createAirspaceForesightTestApp({
    //   someClient: { someMethod: async () => { throw new Error("boom"); } },
    // });
    // const res = await request(errApp).get("/api/recommendations");
    // assertError(res, 500, "Internal error occurred");
  });
});
