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
import { getAnalysis, getWeather, listSnapshots } from "../../../engine/store.js";

export interface WeatherControllerControllerState {}

export interface WeatherControllerControllerProps
  extends IWebControllerProps<
    ApiRouterState,
    WeatherControllerControllerState
  > {}

/**
 * Convective hazard cells for one forecast strip. Pass ?strip=<index> directly,
 * or ?t=<demand step index> to resolve the strip covering that step. Returns
 * cells at/above ?minDbz (default 40 — the dataset's "matters" threshold).
 */
export class WeatherControllerController extends WebController<
  ApiRouterState,
  WeatherControllerControllerState
> {
  constructor(props: WeatherControllerControllerProps) {
    super({
      ...props,
      name: "WeatherControllerController",
      action: "weather",
      method: RequestMethod.get,
      stateConverter: DefaultStateExporter,
      middleware: [],
    });
  }

  protected async getInitializedController(
    props: IWebControllerInitProps<ApiRouterState> & {
      state: WeatherControllerControllerState | undefined;
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
        const cube = getWeather(snapshot);
        if (!cube) {
          res.json({ snapshot, hasWeather: false, cells: [] });
          return;
        }
        let strip: number;
        if (req.query.strip != null) {
          strip = Number(req.query.strip);
        } else {
          const a = getAnalysis(snapshot);
          const t = Math.max(
            0,
            Math.min(a.nSteps - 1, Number(req.query.t || 0)),
          );
          strip = a.stepToStrip[t];
        }
        strip = Math.max(0, Math.min(cube.nStrips - 1, strip));
        const minDbz = req.query.minDbz ? Number(req.query.minDbz) : 40;
        const cells = cube.hazardCells(strip, minDbz);
        const sz = cube.cellSizeDeg();
        res.json({
          snapshot,
          hasWeather: true,
          stripIndex: strip,
          validFrom: cube.manifest.strips[strip]?.valid_from,
          validTo: cube.manifest.strips[strip]?.valid_to,
          minDbz,
          cellDeg: sz,
          count: cells.length,
          // compact tuples: [lat, lon, dbz, topFt]
          cells: cells.map((c) => [
            +c.lat.toFixed(3),
            +c.lon.toFixed(3),
            c.dbz,
            c.top,
          ]),
        });
      } catch (e: any) {
        logger.error?.(`weather failed: ${e?.message}`);
        res.status(500).json({ message: "Internal error occurred" });
      }
    };
  }
}
