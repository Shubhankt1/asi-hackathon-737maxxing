import { FunnyJokeClient } from "./client/index.js";
import { AirspaceForesightWebService } from "./web-service.js";

export interface GetSampleFrontendWebserviceProps {
  serviceArgs: {
    funnyJokeBaseUrl?: string;
  };
}
export async function getWebservice(
  props: GetSampleFrontendWebserviceProps & any,
) {
  const state = {
    funnyJokeClient: new FunnyJokeClient({
      baseUrl: props.serviceArgs.funnyJokeBaseUrl,
    }),
  };
  return new AirspaceForesightWebService({
    ...props,
    ...props.serviceArgs,
    state,
  });
}
