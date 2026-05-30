import { IWebServiceProps, WebService } from "@swizzyweb/swizzy-web-service";
import { PageWebRouter } from "./routers/PageRouter/page-router.js";
import { ApiWebRouter } from "./routers/ApiRouter/api-router.js";
import { FunnyJokeClient, IFunnyJokeClient } from "./client/index.js";

export interface AirspaceForesightWebServiceState {
  funnyJokeClient: IFunnyJokeClient;
}

export interface AirspaceForesightWebServiceProps
  extends IWebServiceProps<AirspaceForesightWebServiceState> {
  port: number;
  path?: string;
}

export class AirspaceForesightWebService extends WebService<AirspaceForesightWebServiceState> {
  constructor(props: AirspaceForesightWebServiceProps) {
    super({
      ...props,
      name: "AirspaceForesightWebService",
      path: props.path ?? "",
      packageName: "airspace-foresight-web-service",
      routerClasses: [PageWebRouter, ApiWebRouter],
      middleware: [],
    });
  }
}
