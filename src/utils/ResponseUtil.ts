export interface ApiResponse<T = any> {
    code: number;
    errorType: string | null;
    data: T | null;
}

class ResponseUtil {

    // The base pattern uses a single destructured object
    static format<T>({ code, errorType = null, data = null }: { code: number, errorType?: string | null, data?: T | null }): ApiResponse<T> {
        return {
            code: code,
            errorType: errorType,
            data: data
        };
    }

    // Helper for 200 OK
    static success<T>({ data = null }: { data?: T | null } = {}): ApiResponse<T> {
        return this.format({ code: 200, data });
    }

    // Helper for custom errors
    static error<T>({ code, errorType, data = null }: { code: number, errorType: string, data?: T | null }): ApiResponse<T> {
        return this.format({ code, errorType, data });
    }

    // Helper for 400 Bad Request
    static badRequest({ errorType = 'INVALID_REQUEST', message = 'Invalid request parameters' }: { errorType?: string, message?: string } = {}): ApiResponse<string> {
        return this.format({ code: 400, errorType: errorType, data: message });
    }

    // Helper for 404 Not Found
    static notFound({ errorType, message = 'Resource not found' }: { errorType: string, message?: string }): ApiResponse<string> {
        return this.format({ code: 404, errorType: errorType, data: message });
    }
}

export default ResponseUtil;