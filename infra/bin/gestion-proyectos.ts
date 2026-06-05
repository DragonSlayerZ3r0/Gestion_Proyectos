#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { GestionProyectosStack } from "../lib/gestion-proyectos-stack";

const app = new App();

const appName = app.node.tryGetContext("appName") ?? "gestion-proyectos";
const envName = app.node.tryGetContext("envName") ?? "dev";

new GestionProyectosStack(app, "GestionProyectosDevStack", {
  appName,
  envName,
  initialUserEmail: app.node.tryGetContext("initialUserEmail") ?? "usr041100@banrural.com.gt",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? "186281981036",
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1"
  }
});
