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

export interface RerouteControllerControllerState {}

export interface RerouteControllerControllerProps
  extends IWebControllerProps<ApiRouterState, RerouteControllerControllerState> {}

/**
 * Lateral reroute around the storm for one conflict flight (?id=<conflict id>).
 * Returns the original path and a deviated path that samples clear, with the
 * extra distance / time it costs.
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
        const r = getReroute(snapshot, id);
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
