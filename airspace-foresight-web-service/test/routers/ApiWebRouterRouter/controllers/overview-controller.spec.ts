import { describe, it, before } from "node:test";
import { request, assertOk, assertError, assertStatus } from "@swizzyweb/swizzy-web-service-test-framework";
import { createAirspaceForesightTestApp } from "../../../helpers/create-airspace-foresight-test-app.js";

describe("OverviewControllerController", () => {
  let app: any;

  before(async () => {
    ({ app } = await createAirspaceForesightTestApp());
  });

  it("GET /api-web-router/overview returns 200", async () => {
    const res = await request(app)
      .get("/api-web-router/overview")
      .query({
        snapshot: "test",
      });
    assertOk(res);
  });

  it("GET /api-web-router/overview returns 400 when query params are missing", async () => {
    const res = await request(app).get("/api-web-router/overview");
    assertError(res, 400);
  });

  it("GET /api-web-router/overview returns 400 when snapshot is missing", async () => {
    const res = await request(app)
      .get("/api-web-router/overview")
      .query({});
    assertError(res, 400);
  });

  it("GET /api-web-router/overview returns 500 when an error occurs", async () => {
    // TODO: override a state dependency to throw and verify the 500 response.
    // const { app: errApp } = await createAirspaceForesightTestApp({
    //   someClient: { someMethod: async () => { throw new Error("boom"); } },
    // });
    // const res = await request(errApp).get("/api-web-router/overview")
      .query({
        snapshot: "test",
      });
    // assertError(res, 500, "Internal error occurred");
  });
});
