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
import { getAnalysis, listSnapshots } from "../../../engine/store.js";

export interface DemandControllerControllerState {}

export interface DemandControllerControllerProps
  extends IWebControllerProps<ApiRouterState, DemandControllerControllerState> {}

/**
 * Per-sector demand time series for a snapshot. Returns only sectors that carry
 * traffic at some step (peak > 0); the frontend defaults the rest to 0. This is
 * the matrix the time scrubber colors the map with, fetched once per snapshot.
 */
export class DemandControllerController extends WebController<
  ApiRouterState,
  DemandControllerControllerState
> {
  constructor(props: DemandControllerControllerProps) {
    super({
      ...props,
      name: "DemandControllerController",
      action: "demand",
      method: RequestMethod.get,
      stateConverter: DefaultStateExporter,
      middleware: [],
    });
  }

  protected async getInitializedController(
    props: IWebControllerInitProps<ApiRouterState> & {
      state: DemandControllerControllerState | undefined;
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
        const a = getAnalysis(snapshot);
        const out: {
          name: string;
          band: string;
          capacity: number;
          demand: number[];
        }[] = [];
        for (let s = 0; s < a.sectorNames.length; s++) {
          const base = s * a.nSteps;
          let peak = 0;
          const arr = new Array(a.nSteps);
          for (let ti = 0; ti < a.nSteps; ti++) {
            const d = a.demand[base + ti];
            arr[ti] = d;
            if (d > peak) peak = d;
          }
          if (peak > 0) {
            out.push({
              name: a.sectorNames[s],
              band: a.band[s],
              capacity: a.capacity[s],
              demand: arr,
            });
          }
        }
        res.json({
          snapshot: a.snapshot,
          nSteps: a.nSteps,
          times: a.times.map((t) => new Date(t).toISOString()),
          sectors: out,
        });
      } catch (e: any) {
        logger.error?.(`demand failed: ${e?.message}`);
        res.status(500).json({ message: "Internal error occurred" });
      }
    };
  }
}
