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

export interface OverviewControllerControllerState {}

export interface OverviewControllerControllerProps
  extends IWebControllerProps<
    ApiRouterState,
    OverviewControllerControllerState
  > {}

export class OverviewControllerController extends WebController<
  ApiRouterState,
  OverviewControllerControllerState
> {
  constructor(props: OverviewControllerControllerProps) {
    super({
      ...props,
      name: "OverviewControllerController",
      action: "overview",
      method: RequestMethod.get,
      stateConverter: DefaultStateExporter,
      middleware: [],
    });
  }

  protected async getInitializedController(
    props: IWebControllerInitProps<ApiRouterState> & {
      state: OverviewControllerControllerState | undefined;
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
        res.json({
          snapshot: a.snapshot,
          askedAt: new Date(a.askedAt).toISOString(),
          windowStart: a.windowStart,
          windowEnd: a.windowEnd,
          nSteps: a.nSteps,
          stepMinutes: 5,
          times: a.times.map((t) => new Date(t).toISOString()),
          airborneCount: a.airborneCount,
          nFlights: a.nFlights,
          nAirborneAtAsked: a.nAirborneAtAsked,
          peakAirborne: Math.max(...a.airborneCount),
          nOverDemandSectors: a.hotspots.length,
          totalSectors: a.sectorNames.length,
          hotspots: a.hotspots.slice(0, 15),
          hasWeather: a.hasWeather,
          nWeatherStrips: a.nWeatherStrips,
          stepToStrip: a.stepToStrip,
          nConflicts: a.conflicts.length,
          builtMs: a.builtMs,
        });
      } catch (e: any) {
        logger.error?.(`overview failed: ${e?.message}`);
        res.status(500).json({ message: "Internal error occurred" });
      }
    };
  }
}
