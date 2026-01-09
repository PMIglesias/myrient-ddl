// Implementación del patrón Circuit Breaker para manejo inteligente de errores repetidos
// Previene sobrecargar servicios que están fallando al rechazar requests después de múltiples errores
// 
// Estados del Circuit Breaker:
// - CLOSED: Estado normal, permite todas las requests y monitorea errores
// - OPEN: Bloqueado después de alcanzar el umbral de errores, rechaza requests inmediatamente
// - HALF_OPEN: Estado de prueba después del timeout, permite algunas requests para verificar recuperación
// 
// Implementación inspirada en Hystrix y resilience4j

const log = require('./logger');

// Constantes que definen los posibles estados del Circuit Breaker
const CircuitState = {
    CLOSED: 'CLOSED',
    OPEN: 'OPEN',
    HALF_OPEN: 'HALF_OPEN'
};

// Clase que implementa el patrón Circuit Breaker para proteger operaciones contra errores repetidos
class CircuitBreaker {
    // Inicializa el Circuit Breaker con opciones de configuración
    // options.name: Nombre identificador usado en logs
    // options.failureThreshold: Cantidad de errores consecutivos antes de abrir el circuito (default: 5)
    // options.successThreshold: Cantidad de éxitos necesarios para cerrar desde HALF_OPEN (default: 2)
    // options.timeout: Tiempo en milisegundos que el circuito permanece OPEN antes de intentar HALF_OPEN (default: 60000)
    // options.resetTimeout: Tiempo en milisegundos para resetear contadores cuando está CLOSED (default: 60000)
    // options.onStateChange: Callback opcional que se ejecuta cuando el estado del circuito cambia
    // options.shouldOpen: Función opcional personalizada para decidir cuándo abrir el circuito
    // options.shouldClose: Función opcional personalizada para decidir cuándo cerrar el circuito
    constructor(options = {}) {
        this.name = options.name || 'CircuitBreaker';
        this.failureThreshold = options.failureThreshold || 5;
        this.successThreshold = options.successThreshold || 2;
        this.timeout = options.timeout || 60000;
        this.resetTimeout = options.resetTimeout || 60000;
        
        // Estado y contadores internos del circuito
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
        this.lastSuccessTime = null;
        this.stateChangedAt = Date.now();
        this.nextAttemptTime = null;
        
        // Callbacks opcionales para personalización del comportamiento
        this.onStateChange = options.onStateChange || (() => {});
        this.shouldOpen = options.shouldOpen || null;
        this.shouldClose = options.shouldClose || null;
        
        // Estadísticas acumuladas del Circuit Breaker para monitoreo y debugging
        this.stats = {
            totalRequests: 0,
            totalSuccesses: 0,
            totalFailures: 0,
            totalRejected: 0,
            totalStateChanges: 0
        };
        
        // Intervalo periódico que resetea contadores cuando el circuito está CLOSED
        // Previene que errores antiguos afecten el comportamiento actual
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
            // Registrar el fallo en las estadísticas del Circuit Breaker
            this._recordFailure(error);
            
            // Re-lanzar el error para que el código que llamó a execute() pueda manejarlo
            throw error;
        }
    }

    // Registra un éxito en la ejecución de una operación protegida
    // Actualiza contadores y estadísticas, y puede causar transición de estado si está en HALF_OPEN
    // Si está en CLOSED y han pasado suficientes éxitos, resetea el contador de fallos
    _recordSuccess() {
        this.lastSuccessTime = Date.now();
        this.stats.totalSuccesses++;

        if (this.state === CircuitState.HALF_OPEN) {
            this.successCount++;
            
            // Si se alcanzan suficientes éxitos consecutivos durante HALF_OPEN, cerrar el circuito
            // Esto indica que el servicio se ha recuperado y está funcionando normalmente
            if (this.successCount >= this.successThreshold) {
                log.info(`[CircuitBreaker:${this.name}] Transición HALF_OPEN -> CLOSED (${this.successCount} éxitos)`);
                this._transitionToState(CircuitState.CLOSED);
            }
        } else if (this.state === CircuitState.CLOSED) {
            // En estado CLOSED, resetear contador de fallos si ha pasado suficiente tiempo desde el último fallo
            // Esto permite que el circuito se recupere gradualmente después de errores temporales
            if (this.failureCount > 0) {
                const timeSinceLastFailure = Date.now() - (this.lastFailureTime || 0);
                if (timeSinceLastFailure > this.resetTimeout) {
                    log.debug(`[CircuitBreaker:${this.name}] Reseteando contador de fallos (${this.failureCount} -> 0)`);
                    this.failureCount = 0;
                }
            }
        }
    }

    // Registra un fallo en la ejecución de una operación protegida
    // Actualiza contadores y puede causar transición a estado OPEN si se alcanza el umbral
    // error: Objeto Error que contiene información sobre el fallo ocurrido
    _recordFailure(error) {
        this.lastFailureTime = Date.now();
        this.failureCount++;
        this.stats.totalFailures++;

        log.debug(`[CircuitBreaker:${this.name}] Fallo registrado (${this.failureCount}/${this.failureThreshold}): ${error.message}`);

        if (this.state === CircuitState.HALF_OPEN) {
            // En estado HALF_OPEN, cualquier fallo inmediatamente vuelve a abrir el circuito
            // Esto es porque HALF_OPEN es un estado de prueba, y un fallo indica que el servicio aún no está recuperado
            log.warn(`[CircuitBreaker:${this.name}] Transición HALF_OPEN -> OPEN (fallo durante prueba)`);
            this._transitionToState(CircuitState.OPEN);
            this.successCount = 0;
        } else if (this.state === CircuitState.CLOSED) {
            // En estado CLOSED, verificar si se alcanzó el umbral de fallos para abrir el circuito
            // Permite función personalizada shouldOpen para lógica de decisión avanzada
            const shouldOpen = this.shouldOpen 
                ? this.shouldOpen(this.failureCount, this.failureThreshold, error)
                : (this.failureCount >= this.failureThreshold);

            if (shouldOpen) {
                log.warn(`[CircuitBreaker:${this.name}] Transición CLOSED -> OPEN (${this.failureCount} fallos)`);
                this._transitionToState(CircuitState.OPEN);
            }
        }
    }

    // Transiciona el Circuit Breaker a un nuevo estado y actualiza todos los contadores relacionados
    // Resetea contadores apropiados según el nuevo estado y notifica el cambio mediante callback
    // newState: Nuevo estado al cual transicionar (CLOSED, OPEN, o HALF_OPEN)
    _transitionToState(newState) {
        if (this.state === newState) return;

        const oldState = this.state;
        this.state = newState;
        this.stateChangedAt = Date.now();
        this.stats.totalStateChanges++;

        // Resetear contadores y timers según el nuevo estado para mantener consistencia
        if (newState === CircuitState.OPEN) {
            // En OPEN, programar el próximo intento de transición a HALF_OPEN después del timeout
            this.nextAttemptTime = Date.now() + this.timeout;
            this.successCount = 0;
        } else if (newState === CircuitState.HALF_OPEN) {
            // En HALF_OPEN, resetear contador de éxitos para comenzar pruebas
            this.successCount = 0;
            this.nextAttemptTime = null;
        } else if (newState === CircuitState.CLOSED) {
            // En CLOSED, resetear todos los contadores ya que el circuito está funcionando normalmente
            this.failureCount = 0;
            this.successCount = 0;
            this.nextAttemptTime = null;
        }

        // Ejecutar callback opcional para notificar cambios de estado
        // Útil para logging externo, métricas, o alertas
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

    // Inicia un intervalo periódico que resetea contadores de fallos cuando el circuito está CLOSED
    // Previene que fallos antiguos afecten el comportamiento actual del Circuit Breaker
    // El intervalo se ejecuta cada resetTimeout/2 o 30 segundos, lo que sea menor
    _startResetInterval() {
        if (this.resetInterval) {
            clearInterval(this.resetInterval);
        }

        // Configurar intervalo que verifica periódicamente si se deben resetear contadores
        // Solo resetea cuando está CLOSED y ha pasado suficiente tiempo desde el último fallo
        this.resetInterval = setInterval(() => {
            if (this.state === CircuitState.CLOSED && this.failureCount > 0) {
                const timeSinceLastFailure = Date.now() - (this.lastFailureTime || 0);
                if (timeSinceLastFailure > this.resetTimeout) {
                    log.debug(`[CircuitBreaker:${this.name}] Reset periódico: ${this.failureCount} -> 0`);
                    this.failureCount = 0;
                }
            }
        }, Math.min(this.resetTimeout / 2, 30000));
    }

    // Fuerza un reset manual del Circuit Breaker al estado CLOSED
    // Útil para debugging o cuando se necesita reiniciar el estado después de una intervención manual
    // Limpia todos los contadores y timers relacionados
    reset() {
        log.info(`[CircuitBreaker:${this.name}] Reset manual forzado`);
        this._transitionToState(CircuitState.CLOSED);
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
        this.lastSuccessTime = null;
        this.nextAttemptTime = null;
    }

    // Obtiene una snapshot completa del estado actual del Circuit Breaker
    // Incluye estado, contadores, timestamps, y estadísticas acumuladas
    // Retorna: Objeto con toda la información del estado actual del Circuit Breaker
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

    // Verifica si el circuito está en estado OPEN (bloqueando todas las requests)
    // Retorna: true si está OPEN, false en caso contrario
    isOpen() {
        return this.state === CircuitState.OPEN;
    }

    // Verifica si el circuito está en estado CLOSED (permitiendo requests normalmente)
    // Retorna: true si está CLOSED, false en caso contrario
    isClosed() {
        return this.state === CircuitState.CLOSED;
    }

    // Verifica si el circuito está en estado HALF_OPEN (modo de prueba después de timeout)
    // Retorna: true si está HALF_OPEN, false en caso contrario
    isHalfOpen() {
        return this.state === CircuitState.HALF_OPEN;
    }

    // Destruye el Circuit Breaker limpiando todos los recursos asociados
    // Detiene intervalos activos y libera memoria
    // Debe llamarse cuando el Circuit Breaker ya no se necesite para evitar memory leaks
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
