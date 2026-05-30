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

export interface SnapshotsControllerControllerState {}

export interface SnapshotsControllerControllerProps
  extends IWebControllerProps<
    ApiRouterState,
    SnapshotsControllerControllerState
  > {}

export class SnapshotsControllerController extends WebController<
  ApiRouterState,
  SnapshotsControllerControllerState
> {
  constructor(props: SnapshotsControllerControllerProps) {
    super({
      ...props,
      name: "SnapshotsControllerController",
      action: "snapshots",
      method: RequestMethod.get,
      stateConverter: DefaultStateExporter,
      middleware: [],
    });
  }

  protected async getInitializedController(
    props: IWebControllerInitProps<ApiRouterState> & {
      state: SnapshotsControllerControllerState | undefined;
    },
  ): Promise<WebControllerFunction> {
    const logger = this.logger;
    return async function (req: Request, res: Response) {
      try {
        res.json({ snapshots: listSnapshots() });
      } catch (e: any) {
        logger.error?.(`snapshots failed: ${e?.message}`);
        res.status(500).json({ message: "Internal error occurred" });
      }
    };
  }
}
