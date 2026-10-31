import { Module } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller';
import { WebhooksController } from './webhooks.controller';

/** Outbound webhooks and inbound connectors. */
@Module({ controllers: [WebhooksController, ConnectorsController] })
export class IntegrationsModule {}
