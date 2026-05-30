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
import { getSectorIndex } from "../../../engine/store.js";

export interface SectorsControllerControllerState {}

export interface SectorsControllerControllerProps
  extends IWebControllerProps<
    ApiRouterState,
    SectorsControllerControllerState
  > {}

/**
 * Static sector geometry (snapshot-independent). Returns rings, capacity, band
 * and centroid so the frontend can draw and label the airspace once, then color
 * by demand fetched separately. Optional ?band=HIGH|LOW filter.
 */
export class SectorsControllerController extends WebController<
  ApiRouterState,
  SectorsControllerControllerState
> {
  constructor(props: SectorsControllerControllerProps) {
    super({
      ...props,
      name: "SectorsControllerController",
      action: "sectors",
      method: RequestMethod.get,
      stateConverter: DefaultStateExporter,
      middleware: [],
    });
  }

  protected async getInitializedController(
    props: IWebControllerInitProps<ApiRouterState> & {
      state: SectorsControllerControllerState | undefined;
    },
  ): Promise<WebControllerFunction> {
    const logger = this.logger;
    return async function (req: Request, res: Response) {
      try {
        const bandFilter = (req.query.band as string)?.toUpperCase();
        const idx = getSectorIndex();
        const sectors = idx.sectors
          .filter((s) => !bandFilter || s.band === bandFilter)
          .map((s) => ({
            name: s.name,
            band: s.band,
            capacity: s.capacity,
            altitude_from_ft: s.altitude_from_ft,
            altitude_to_ft: s.altitude_to_ft,
            centroid: s.centroid,
            ring: s.ring,
          }));
        res.json({ count: sectors.length, sectors });
      } catch (e: any) {
        logger.error?.(`sectors failed: ${e?.message}`);
        res.status(500).json({ message: "Internal error occurred" });
      }
    };
  }
}
