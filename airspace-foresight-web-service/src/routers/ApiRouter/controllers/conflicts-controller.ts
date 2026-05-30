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

export interface ConflictsControllerControllerState {}

export interface ConflictsControllerControllerProps
  extends IWebControllerProps<
    ApiRouterState,
    ConflictsControllerControllerState
  > {}

/**
 * Flights whose planned trajectory penetrates convective hazard (>=40 dBZ with
 * storm tops at/above the flight's cruise altitude). Includes route waypoints +
 * hazard time intervals so the client can animate each flight and flag it red
 * while it is inside weather. Sorted by time-in-hazard.
 */
export class ConflictsControllerController extends WebController<
  ApiRouterState,
  ConflictsControllerControllerState
> {
  constructor(props: ConflictsControllerControllerProps) {
    super({
      ...props,
      name: "ConflictsControllerController",
      action: "conflicts",
      method: RequestMethod.get,
      stateConverter: DefaultStateExporter,
      middleware: [],
    });
  }

  protected async getInitializedController(
    props: IWebControllerInitProps<ApiRouterState> & {
      state: ConflictsControllerControllerState | undefined;
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
        const limit = req.query.limit ? Number(req.query.limit) : 400;
        const a = getAnalysis(snapshot);
        res.json({
          snapshot: a.snapshot,
          hasWeather: a.hasWeather,
          nConflicts: a.conflicts.length,
          stepMinutes: 5,
          conflicts: a.conflicts.slice(0, limit).map((c) => ({
            id: c.id,
            flightNumber: c.flightNumber,
            origin: c.origin,
            dest: c.dest,
            altFt: c.altFt,
            t0: c.t0,
            t1: c.t1,
            lats: c.lats,
            lons: c.lons,
            intervals: c.intervals,
            hazardSteps: c.hazardSteps,
            hazardMinutes: c.hazardSteps * 5,
            maxDbz: c.maxDbz,
            peakLat: c.peakLat,
            peakLon: c.peakLon,
            peakTime: c.peakTime,
          })),
        });
      } catch (e: any) {
        logger.error?.(`conflicts failed: ${e?.message}`);
        res.status(500).json({ message: "Internal error occurred" });
      }
    };
  }
}
