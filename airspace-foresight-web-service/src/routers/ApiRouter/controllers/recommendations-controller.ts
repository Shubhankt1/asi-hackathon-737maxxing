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
import { getRecommendations } from "../../../engine/recommend.js";

export interface RecommendationsControllerControllerState {}

export interface RecommendationsControllerControllerProps
  extends IWebControllerProps<
    ApiRouterState,
    RecommendationsControllerControllerState
  > {}

/**
 * Ranked, quantified mitigations: minimal departure delays that clear weather
 * conflicts (using the time-evolving forecast) and sector metering to bring
 * over-demand back to capacity, each with before/after numbers.
 */
export class RecommendationsControllerController extends WebController<
  ApiRouterState,
  RecommendationsControllerControllerState
> {
  constructor(props: RecommendationsControllerControllerProps) {
    super({
      ...props,
      name: "RecommendationsControllerController",
      action: "recommendations",
      method: RequestMethod.get,
      stateConverter: DefaultStateExporter,
      middleware: [],
    });
  }

  protected async getInitializedController(
    props: IWebControllerInitProps<ApiRouterState> & {
      state: RecommendationsControllerControllerState | undefined;
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
        const limit = req.query.limit ? Number(req.query.limit) : 120;
        const r = getRecommendations(snapshot);
        res.json({
          snapshot: r.snapshot,
          summary: r.summary,
          weather: r.weather.slice(0, limit),
          sectors: r.sectors,
        });
      } catch (e: any) {
        logger.error?.(`recommendations failed: ${e?.message}`);
        res.status(500).json({ message: "Internal error occurred" });
      }
    };
  }
}
