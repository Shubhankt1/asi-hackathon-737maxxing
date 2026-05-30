import {
  DefaultStateExporter,
  IWebControllerInitProps,
  IWebControllerProps,
  RequestMethod,
  WebController,
  WebControllerFunction,
} from "@swizzyweb/swizzy-web-service";
import { ApiRouterState } from "../api-router.js";
import { Request, Response } from "express";
import { getBasemap } from "../../../engine/store.js";

export interface BasemapControllerControllerState {}

export interface BasemapControllerControllerProps
  extends IWebControllerProps<
    ApiRouterState,
    BasemapControllerControllerState
  > {}

/**
 * Offline US basemap geometry (snapshot-independent): CONUS state polygons and a
 * merged landmass outline (WGS84 lon/lat), so the map can draw a light
 * carto-positron-style base + state borders without any external tiles.
 */
export class BasemapControllerController extends WebController<
  ApiRouterState,
  BasemapControllerControllerState
> {
  constructor(props: BasemapControllerControllerProps) {
    super({
      ...props,
      name: "BasemapControllerController",
      action: "basemap",
      method: RequestMethod.get,
      stateConverter: DefaultStateExporter,
      middleware: [],
    });
  }

  protected async getInitializedController(
    props: IWebControllerInitProps<ApiRouterState> & {
      state: BasemapControllerControllerState | undefined;
    },
  ): Promise<WebControllerFunction> {
    const logger = this.logger;
    return async function (req: Request, res: Response) {
      try {
        const { states, nation } = getBasemap();
        res.json({ states, nation });
      } catch (e: any) {
        logger.error?.(`basemap failed: ${e?.message}`);
        res.status(500).json({ message: "Internal error occurred" });
      }
    };
  }
}
