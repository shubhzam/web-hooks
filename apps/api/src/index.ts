import express from "express";

// placeholder server, step 5 replaces this with the health routes
const app = express();
const port = Number(process.env.API_PORT ?? 3001);

app.listen(port, () => {
  console.log(`api listening on ${port}`);
});
