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
import path from "path";
import express from "express";
import { fileURLToPath } from "node:url";

// This gives you the directory where *this* file is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface PageRouterState {}

export interface PageRouterProps
  extends IWebRouterProps<AirspaceForesightWebServiceState, PageRouterState> {}
export class PageWebRouter extends WebRouter<
  AirspaceForesightWebServiceState,
  PageRouterState
> {
  constructor(props: PageRouterProps) {
    super({
      ...props,
      name: "PageWebRouter",
      path: "",
      stateConverter: PageRouterStateConverter,
      webControllerClasses: [],
      middleware: [
        SwizzyRequestMiddleware,
        RequestIdMiddleware,
        RequestLoggerMiddleware,
        () => express.static(path.join(__dirname, "../../../bundle")),
      ],
    });
  }
}

const PageRouterStateConverter: StateConverter<
  AirspaceForesightWebServiceState,
  PageRouterState
> = async function (
  props: StateConverterProps<AirspaceForesightWebServiceState>,
): Promise<PageRouterState> {
  return { ...props.state };
};
