import { resolveRuntimeUrls } from '@/config/runtimeUrls';

const runtimeUrls = resolveRuntimeUrls();

export const HOME_PAGE_BASE_URL = runtimeUrls.homePageBaseUrl;
export const BACKEND_API_BASE_URL = runtimeUrls.backendApiBaseUrl ?? '';

export const BACKEND_GENERAL_API = `${BACKEND_API_BASE_URL}/api/v1`;
export const LLM_API_URL = runtimeUrls.llmApiUrl ?? `${BACKEND_API_BASE_URL}/api/llm`;
