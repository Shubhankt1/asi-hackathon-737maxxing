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
import { getPositionsAtStep, listSnapshots } from "../../../engine/store.js";

export interface PositionsControllerControllerState {}

export interface PositionsControllerControllerProps
  extends IWebControllerProps<
    ApiRouterState,
    PositionsControllerControllerState
  > {}

/**
 * Positions of all airborne flights at demand step ?t=, as compact tuples
 * [lon, lat, band(1=HIGH/0=LOW), inWeather(1/0)]. Powers the "all flights"
 * display mode.
 */
export class PositionsControllerController extends WebController<
  ApiRouterState,
  PositionsControllerControllerState
> {
  constructor(props: PositionsControllerControllerProps) {
    super({
      ...props,
      name: "PositionsControllerController",
      action: "positions",
      method: RequestMethod.get,
      stateConverter: DefaultStateExporter,
      middleware: [],
    });
  }

  protected async getInitializedController(
    props: IWebControllerInitProps<ApiRouterState> & {
      state: PositionsControllerControllerState | undefined;
    },
  ): Promise<WebControllerFunction> {
    const logger = this.logger;
    return async function (req: Request, res: Response) {
      try {
        const snapshot =
          (req.query.snapshot as string) || listSnapshots()[0]?.snapshot;
        if (!snapshot) {
          res.status(404).json({ message: "no snapshots available" });
          return;
        }
        const t = Math.max(0, Number(req.query.t || 0));
        const flights = getPositionsAtStep(snapshot, t);
        res.json({ snapshot, t, count: flights.length, flights });
      } catch (e: any) {
        logger.error?.(`positions failed: ${e?.message}`);
        res.status(500).json({ message: "Internal error occurred" });
      }
    };
  }
}
