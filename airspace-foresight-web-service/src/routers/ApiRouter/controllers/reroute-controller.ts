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
import { listSnapshots } from "../../../engine/store.js";
import { getReroute } from "../../../engine/reroute.js";
import { REROUTERS } from "../../../engine/router.js";

export interface RerouteControllerControllerState {}

export interface RerouteControllerControllerProps
  extends IWebControllerProps<ApiRouterState, RerouteControllerControllerState> {}

/**
 * Weather-aware reroute around the storm for one conflict flight
 * (?id=<conflict id>&algo=thetastar|astar&t=<epoch ms>). Runs an A-star /
 * Theta-star search from the aircraft's position at time `t` to its destination, returning
 * the planned remaining leg and the routed path with the extra distance / time.
 */
export class RerouteControllerController extends WebController<
  ApiRouterState,
  RerouteControllerControllerState
> {
  constructor(props: RerouteControllerControllerProps) {
    super({
      ...props,
      name: "RerouteControllerController",
      action: "reroute",
      method: RequestMethod.get,
      stateConverter: DefaultStateExporter,
      middleware: [],
    });
  }

  protected async getInitializedController(
    props: IWebControllerInitProps<ApiRouterState> & {
      state: RerouteControllerControllerState | undefined;
    },
  ): Promise<WebControllerFunction> {
    const logger = this.logger;
    return async function (req: Request, res: Response) {
      try {
        const snapshot =
          (req.query.snapshot as string) || listSnapshots()[0]?.snapshot;
        const id = req.query.id as string;
        if (!snapshot || !id) {
          res.status(400).json({ message: "snapshot and id required" });
          return;
        }
        const algoParam = (req.query.algo as string) || "thetastar";
        const algo = algoParam in REROUTERS ? algoParam : "thetastar";
        const t = req.query.t ? Number(req.query.t) : 0;
        const r = getReroute(snapshot, id, algo, t);
        if (!r) {
          res.status(404).json({ message: "no weather or flight not found" });
          return;
        }
        res.json(r);
      } catch (e: any) {
        logger.error?.(`reroute failed: ${e?.message}`);
        res.status(500).json({ message: "Internal error occurred" });
      }
    };
  }
}
