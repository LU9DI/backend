/** Contratos mínimos compartilhados entre produtos. */

export type ProductId =
  | 'shopping-agent'
  | 'business-agents'
  | 'agent-marketplace'
  | 'tax-platform';

export type Environment = 'development' | 'test' | 'production';

export interface ProductContext {
  productId: ProductId;
  environment: Environment;
  userId?: string;
  requestId?: string;
}

export interface UsageEvent {
  productId: ProductId;
  userId?: string;
  feature: string;
  quantity?: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AgentTask {
  id: string;
  productId: ProductId;
  userId: string;
  type: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProductModule {
  id: ProductId;
  name: string;
  version: string;
  enabled: boolean;
}
