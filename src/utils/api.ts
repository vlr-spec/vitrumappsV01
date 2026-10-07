export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
export const API_BASE = API_BASE_URL;

const REQUEST_TIMEOUT_MS = 30000;

/**
 * A helper function to make authenticated requests to our FastAPI backend.
 * All calls go through here so we have one place to manage headers and error handling.
 */
export const apiFetch = async (endpoint: string, options: RequestInit = {}) => {
    const url = endpoint.startsWith("http") ? endpoint : `${API_BASE_URL}${endpoint}`;

    const headers = {
        "Content-Type": "application/json",
        ...(localStorage.getItem('authToken') ? { Authorization: `Bearer ${localStorage.getItem('authToken')}` } : {}),
        ...options.headers,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), REQUEST_TIMEOUT_MS);
    if (options.signal) {
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
        response = await fetch(url, { ...options, headers, signal: controller.signal });
    } catch (error) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
            throw new Error('The request timed out. Please check your connection and try again.');
        }
        if (error instanceof TypeError) {
            throw new Error('Unable to reach the server. Please check that the backend is running.');
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        const detail = errorData?.detail;
        if (typeof detail === 'string') throw new Error(detail);
        if (Array.isArray(detail) && detail.length > 0) throw new Error(detail.map((err) => err?.msg).filter(Boolean).join('; '));
        throw new Error(`API Request failed with status ${response.status}`);
    }

    const text = await response.text();
    if (!text) {
        return null;
    }
    return JSON.parse(text);
};
