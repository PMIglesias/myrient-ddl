/**
 * Circuit Breaker Pattern para manejo de errores repetidos
 * 
 * Estados:
 * - CLOSED: Operación normal, permite requests
 * - OPEN: Bloqueado, rechaza requests inmediatamente (después de N errores)
 * - HALF_OPEN: Estado de prueba, permite algunos requests para verificar recuperación
 * 
 * Implementación inspirada en Hystrix y resilience4j
 */

const log = require('./logger');

/**
 * Estados del Circuit Breaker
 */
const CircuitState = {
    CLOSED: 'CLOSED',      // Normal, permite requests
    OPEN: 'OPEN',          // Bloqueado, rechaza requests
    HALF_OPEN: 'HALF_OPEN' // Prueba, permite algunos requests
};

/**
 * Clase CircuitBreaker
 */
class CircuitBreaker {
    /**
     * @param {Object} options - Opciones de configuración
     * @param {string} options.name - Nombre del circuit breaker (para logging)
     * @param {number} options.failureThreshold - Número de errores antes de abrir (default: 5)
     * @param {number} options.successThreshold - Número de éxitos para cerrar desde HALF_OPEN (default: 2)
     * @param {number} options.timeout - Tiempo en OPEN antes de intentar HALF_OPEN (ms) (default: 60000)
     * @param {number} options.resetTimeout - Tiempo para resetear contadores en CLOSED (ms) (default: 60000)
     * @param {Function} options.onStateChange - Callback cuando cambia el estado
     * @param {Function} options.shouldOpen - Función personalizada para decidir si abrir (opcional)
     * @param {Function} options.shouldClose - Función personalizada para decidir si cerrar (opcional)
     */
    constructor(options = {}) {
        this.name = options.name || 'CircuitBreaker';
        this.failureThreshold = options.failureThreshold || 5;
        this.successThreshold = options.successThreshold || 2;
        this.timeout = options.timeout || 60000; // 60 segundos
        this.resetTimeout = options.resetTimeout || 60000; // 60 segundos
        
        // Estado actual
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
        this.lastSuccessTime = null;
        this.stateChangedAt = Date.now();
        this.nextAttemptTime = null;
        
        // Callbacks
        this.onStateChange = options.onStateChange || (() => {});
        this.shouldOpen = options.shouldOpen || null;
        this.shouldClose = options.shouldClose || null;
        
        // Estadísticas
        this.stats = {
            totalRequests: 0,
            totalSuccesses: 0,
            totalFailures: 0,
            totalRejected: 0,
            totalStateChanges: 0
        };
        
        // Reset periódico de contadores en CLOSED
        this.resetInterval = null;
        this._startResetInterval();
    }

    /**
     * Ejecuta una operación protegida por el circuit breaker
     * @param {Function} operation - Función a ejecutar (debe retornar Promise)
     * @param {*} fallback - Valor o función de fallback si el circuit está OPEN
     * @returns {Promise} Resultado de la operación o fallback
     */
    async execute(operation, fallback = null) {
        this.stats.totalRequests++;

        // Si el circuit está OPEN, verificar si es tiempo de intentar HALF_OPEN
        if (this.state === CircuitState.OPEN) {
            if (Date.now() >= this.nextAttemptTime) {
                log.debug(`[CircuitBreaker:${this.name}] Intentando transición OPEN -> HALF_OPEN`);
                this._transitionToState(CircuitState.HALF_OPEN);
            } else {
                // Aún en OPEN, rechazar request
                this.stats.totalRejected++;
                log.debug(`[CircuitBreaker:${this.name}] Request rechazado (OPEN hasta ${new Date(this.nextAttemptTime).toISOString()})`);
                
                if (typeof fallback === 'function') {
                    return fallback();
                }
                return fallback;
            }
        }

        // Intentar ejecutar la operación
        try {
            const result = await operation();
            
            // Éxito
            this._recordSuccess();
            return result;
            
        } catch (error) {
            // Error
            this._recordFailure(error);
            
            // Re-lanzar el error para que el caller lo maneje
            throw error;
        }
    }

    /**
     * Registra un éxito
     */
    _recordSuccess() {
        this.lastSuccessTime = Date.now();
        this.stats.totalSuccesses++;

        if (this.state === CircuitState.HALF_OPEN) {
            this.successCount++;
            
            // Si tenemos suficientes éxitos, cerrar el circuit
            if (this.successCount >= this.successThreshold) {
                log.info(`[CircuitBreaker:${this.name}] Transición HALF_OPEN -> CLOSED (${this.successCount} éxitos)`);
                this._transitionToState(CircuitState.CLOSED);
            }
        } else if (this.state === CircuitState.CLOSED) {
            // Resetear contador de fallos si hay éxito reciente
            if (this.failureCount > 0) {
                const timeSinceLastFailure = Date.now() - (this.lastFailureTime || 0);
                if (timeSinceLastFailure > this.resetTimeout) {
                    log.debug(`[CircuitBreaker:${this.name}] Reseteando contador de fallos (${this.failureCount} -> 0)`);
                    this.failureCount = 0;
                }
            }
        }
    }

    /**
     * Registra un fallo
     */
    _recordFailure(error) {
        this.lastFailureTime = Date.now();
        this.failureCount++;
        this.stats.totalFailures++;

        log.debug(`[CircuitBreaker:${this.name}] Fallo registrado (${this.failureCount}/${this.failureThreshold}): ${error.message}`);

        if (this.state === CircuitState.HALF_OPEN) {
            // En HALF_OPEN, cualquier fallo vuelve a abrir
            log.warn(`[CircuitBreaker:${this.name}] Transición HALF_OPEN -> OPEN (fallo durante prueba)`);
            this._transitionToState(CircuitState.OPEN);
            this.successCount = 0;
        } else if (this.state === CircuitState.CLOSED) {
            // Verificar si debería abrir
            const shouldOpen = this.shouldOpen 
                ? this.shouldOpen(this.failureCount, this.failureThreshold, error)
                : (this.failureCount >= this.failureThreshold);

            if (shouldOpen) {
                log.warn(`[CircuitBreaker:${this.name}] Transición CLOSED -> OPEN (${this.failureCount} fallos)`);
                this._transitionToState(CircuitState.OPEN);
            }
        }
    }

    /**
     * Transiciona a un nuevo estado
     */
    _transitionToState(newState) {
        if (this.state === newState) return;

        const oldState = this.state;
        this.state = newState;
        this.stateChangedAt = Date.now();
        this.stats.totalStateChanges++;

        // Resetear contadores según el nuevo estado
        if (newState === CircuitState.OPEN) {
            this.nextAttemptTime = Date.now() + this.timeout;
            this.successCount = 0;
        } else if (newState === CircuitState.HALF_OPEN) {
            this.successCount = 0;
            this.nextAttemptTime = null;
        } else if (newState === CircuitState.CLOSED) {
            this.failureCount = 0;
            this.successCount = 0;
            this.nextAttemptTime = null;
        }

        // Notificar cambio de estado
        try {
            this.onStateChange({
                name: this.name,
                oldState,
                newState,
                timestamp: this.stateChangedAt,
                failureCount: this.failureCount,
                successCount: this.successCount
            });
        } catch (err) {
            log.error(`[CircuitBreaker:${this.name}] Error en callback onStateChange:`, err);
        }

        log.info(`[CircuitBreaker:${this.name}] Estado: ${oldState} -> ${newState}`);
    }

    /**
     * Inicia el intervalo de reset periódico
     */
    _startResetInterval() {
        if (this.resetInterval) {
            clearInterval(this.resetInterval);
        }

        // Resetear contadores cada resetTimeout en CLOSED
        this.resetInterval = setInterval(() => {
            if (this.state === CircuitState.CLOSED && this.failureCount > 0) {
                const timeSinceLastFailure = Date.now() - (this.lastFailureTime || 0);
                if (timeSinceLastFailure > this.resetTimeout) {
                    log.debug(`[CircuitBreaker:${this.name}] Reset periódico: ${this.failureCount} -> 0`);
                    this.failureCount = 0;
                }
            }
        }, Math.min(this.resetTimeout / 2, 30000)); // Revisar cada 30s o mitad del timeout
    }

    /**
     * Fuerza el reset del circuit breaker a CLOSED
     */
    reset() {
        log.info(`[CircuitBreaker:${this.name}] Reset manual forzado`);
        this._transitionToState(CircuitState.CLOSED);
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
        this.lastSuccessTime = null;
        this.nextAttemptTime = null;
    }

    /**
     * Obtiene el estado actual
     */
    getState() {
        return {
            state: this.state,
            failureCount: this.failureCount,
            successCount: this.successCount,
            lastFailureTime: this.lastFailureTime,
            lastSuccessTime: this.lastSuccessTime,
            nextAttemptTime: this.nextAttemptTime,
            stats: { ...this.stats }
        };
    }

    /**
     * Verifica si el circuit está abierto (bloqueando requests)
     */
    isOpen() {
        return this.state === CircuitState.OPEN;
    }

    /**
     * Verifica si el circuit está cerrado (permitiendo requests normalmente)
     */
    isClosed() {
        return this.state === CircuitState.CLOSED;
    }

    /**
     * Verifica si el circuit está en modo de prueba
     */
    isHalfOpen() {
        return this.state === CircuitState.HALF_OPEN;
    }

    /**
     * Destruye el circuit breaker y limpia recursos
     */
    destroy() {
        if (this.resetInterval) {
            clearInterval(this.resetInterval);
            this.resetInterval = null;
        }
        log.debug(`[CircuitBreaker:${this.name}] Destruido`);
    }
}

module.exports = {
    CircuitBreaker,
    CircuitState
};
