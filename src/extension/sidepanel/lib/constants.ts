export const HOME_PAGE_BASE_URL = import.meta.env.VITE_HOME_PAGE_BASE_URL || 'https://airepublic.com';
export const BACKEND_API_BASE_URL = import.meta.env.VITE_BACKEND_API_BASE_URL || '';

export const BACKEND_GENERAL_API = `${BACKEND_API_BASE_URL}/api/v1`;
export const LLM_API_URL = `${BACKEND_API_BASE_URL}/api/llm`;