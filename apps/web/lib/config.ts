class Config {
  // server side only, the browser never talks to the api directly
  readonly apiUrl = process.env.API_URL ?? "http://localhost:3001";
}

export const config = new Config();