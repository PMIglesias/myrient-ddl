/**
 * useErrorHandling - Composable para manejo centralizado de errores
 *
 * Maneja errores del proceso principal de Electron y errores globales
 */

import { onMounted, onUnmounted } from 'vue';
import { useToasts } from './useToasts';
import { onErrorNotification } from '../services/api';
import logger from '../utils/logger';

export function useErrorHandling() {
  const errorLogger = logger.child('ErrorHandling');
  const { showToast } = useToasts();

  /**
   * Maneja errores recibidos del proceso principal de Electron
   */
  const handleMainProcessError = errorInfo => {
    errorLogger.error('Error del proceso principal:', errorInfo);

    // Determinar mensaje amigable basado en el tipo de error
    let title = 'Error en la aplicación';
    let message =
      'Ha ocurrido un error inesperado. La aplicación puede comportarse de manera inesperada.';

    if (errorInfo?.message) {
      const msg = errorInfo.message.toLowerCase();

      if (msg.includes('network') || msg.includes('fetch') || msg.includes('connection')) {
        title = 'Error de conexión';
        message = 'Error de conexión con el proceso principal. Intenta recargar la aplicación.';
      } else if (msg.includes('timeout')) {
        title = 'Timeout';
        message = 'Una operación tardó demasiado tiempo. Intenta nuevamente.';
      } else if (msg.includes('permission') || msg.includes('access') || msg.includes('eacces')) {
        title = 'Error de permisos';
        message =
          'No tienes permisos para realizar esta operación. Verifica los permisos de archivos.';
      } else if (msg.includes('quota') || msg.includes('storage') || msg.includes('enospc')) {
        title = 'Espacio insuficiente';
        message = 'No hay suficiente espacio de almacenamiento disponible.';
      } else if (msg.includes('database') || msg.includes('sqlite') || msg.includes('db')) {
        title = 'Error de base de datos';
        message =
          'Error accediendo a la base de datos. Puede que necesites reiniciar la aplicación.';
      } else if (errorInfo.type === 'uncaughtException') {
        title = 'Error crítico';
        message = `Error crítico: ${errorInfo.message.substring(0, 150)}${errorInfo.message.length > 150 ? '...' : ''}`;
      } else if (errorInfo.type === 'unhandledRejection') {
        title = 'Error asíncrono';
        message = `Error en operación asíncrona: ${errorInfo.message.substring(0, 150)}${errorInfo.message.length > 150 ? '...' : ''}`;
      } else {
        message = errorInfo.message.substring(0, 200);
        if (errorInfo.message.length > 200) message += '...';
      }
    }

    // Mostrar toast con el error
    showToast({
      title,
      message,
      type: 'error',
      duration: 10000, // Mostrar por más tiempo para errores críticos
    });
  };

  let unsubscribeErrorNotification = null;

  /**
   * Inicializa el manejo de errores
   */
  const init = () => {
    // Suscribirse a errores del proceso principal
    try {
      unsubscribeErrorNotification = onErrorNotification(handleMainProcessError);
      errorLogger.info('Manejo de errores inicializado');
    } catch (error) {
      errorLogger.error('Error inicializando manejo de errores:', error);
    }
  };

  /**
   * Limpia los listeners de errores
   */
  const cleanup = () => {
    if (unsubscribeErrorNotification) {
      try {
        unsubscribeErrorNotification();
        unsubscribeErrorNotification = null;
        errorLogger.info('Manejo de errores limpiado');
      } catch (error) {
        errorLogger.error('Error limpiando manejo de errores:', error);
      }
    }
  };

  return {
    init,
    cleanup,
    handleMainProcessError,
  };
}
