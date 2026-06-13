#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { GestionProyectosStack } from "../lib/gestion-proyectos-stack";

const app = new App();

const appName = app.node.tryGetContext("appName") ?? "gestion-proyectos";
const envName = app.node.tryGetContext("envName") ?? "dev";

// ID del stack derivado del ambiente: dev -> GestionProyectosDevStack (igual que
// antes, no reemplaza el stack existente), prod -> GestionProyectosProdStack.
const stackId = `GestionProyectos${envName.charAt(0).toUpperCase()}${envName.slice(1)}Stack`;

new GestionProyectosStack(app, stackId, {
  appName,
  envName,
  initialUserEmail: app.node.tryGetContext("initialUserEmail") ?? "usr041100@banrural.com.gt",
  // En cuentas gobernadas (prod), el admin pre-crea el rol de la Lambda y se pasa
  // por contexto: `--context apiRoleArn=arn:aws:iam::<cuenta>:role/<rol>`.
  // Si se omite (dev), el stack crea el rol.
  apiRoleArn: app.node.tryGetContext("apiRoleArn"),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? "186281981036",
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1"
  }
});
