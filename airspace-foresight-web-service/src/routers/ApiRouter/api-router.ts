import {
  IWebRouterProps,
  RequestIdMiddleware,
  RequestLoggerMiddleware,
  StateConverter,
  StateConverterProps,
  SwizzyRequestMiddleware,
  WebRouter,
} from "@swizzyweb/swizzy-web-service";
import { AirspaceForesightWebServiceState } from "../../web-service.js";
import { FunnyJokeController } from "./controllers/funny-joke-controller.js";
import { IFunnyJokeClient } from "../../client/index.js";
import { SnapshotsControllerController } from "./controllers/snapshots-controller.js";
import { OverviewControllerController } from "./controllers/overview-controller.js";
import { SectorsControllerController } from "./controllers/sectors-controller.js";
import { DemandControllerController } from "./controllers/demand-controller.js";
import { WeatherControllerController } from "./controllers/weather-controller.js";
import { ConflictsControllerController } from "./controllers/conflicts-controller.js";
import { RecommendationsControllerController } from "./controllers/recommendations-controller.js";
import { RerouteControllerController } from "./controllers/reroute-controller.js";
import { WhatifControllerController } from "./controllers/whatif-controller.js";
export interface ApiRouterState {
  funnyJokeClient: IFunnyJokeClient;
}

export interface ApiRouterProps
  extends IWebRouterProps<AirspaceForesightWebServiceState, ApiRouterState> {}
export class ApiWebRouter extends WebRouter<
  AirspaceForesightWebServiceState,
  ApiRouterState
> {
  constructor(props: ApiRouterProps) {
    super({
      ...props,
      name: "ApiWebRouter",
      path: "api",
      stateConverter: ApiRouterStateConverter,
      webControllerClasses: [
        FunnyJokeController,
        SnapshotsControllerController,
        OverviewControllerController,
        SectorsControllerController,
        DemandControllerController,

        WeatherControllerController,

        ConflictsControllerController,

        RecommendationsControllerController,

        RerouteControllerController,

        WhatifControllerController,],
      middleware: [
        SwizzyRequestMiddleware,
        RequestIdMiddleware,
        RequestLoggerMiddleware,
      ],
    });
  }
}

const ApiRouterStateConverter: StateConverter<
  AirspaceForesightWebServiceState,
  ApiRouterState
> = async function (
  props: StateConverterProps<AirspaceForesightWebServiceState>,
): Promise<ApiRouterState> {
  return { ...props.state };
};
