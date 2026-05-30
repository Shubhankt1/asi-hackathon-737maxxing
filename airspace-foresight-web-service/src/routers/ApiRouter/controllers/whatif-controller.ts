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
import { getWhatIf } from "../../../engine/whatif.js";

export interface WhatifControllerControllerState {}

export interface WhatifControllerControllerProps
  extends IWebControllerProps<ApiRouterState, WhatifControllerControllerState> {}

/**
 * Mitigated sector demand: re-runs the demand model with recommended weather
 * departure delays applied, returning the new per-sector series plus a
 * before/after diff (sectors relieved vs newly stressed).
 */
export class WhatifControllerController extends WebController<
  ApiRouterState,
  WhatifControllerControllerState
> {
  constructor(props: WhatifControllerControllerProps) {
    super({
      ...props,
      name: "WhatifControllerController",
      action: "whatif",
      method: RequestMethod.get,
      stateConverter: DefaultStateExporter,
      middleware: [],
    });
  }

  protected async getInitializedController(
    props: IWebControllerInitProps<ApiRouterState> & {
      state: WhatifControllerControllerState | undefined;
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
        res.json(getWhatIf(snapshot));
      } catch (e: any) {
        logger.error?.(`whatif failed: ${e?.message}`);
        res.status(500).json({ message: "Internal error occurred" });
      }
    };
  }
}
