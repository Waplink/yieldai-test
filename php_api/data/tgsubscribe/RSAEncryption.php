<?php
class RSAEncryption {
    private $privateKey;
    private $privateKeyPath;
    
    public function __construct() {
        $this->privateKeyPath = __DIR__ . '/../ssl/private.pem';
        $this->loadPrivateKey();
    }
    
    private function loadPrivateKey() {
        if (!file_exists($this->privateKeyPath)) {
            return [
				'error'=>1,
				'message'=>'Server error 1003, please contact technical support',
			];
        }
        
        $keyContent = file_get_contents($this->privateKeyPath);
        if ($keyContent === false) {
            return [
				'error'=>1,
				'message'=>'Server error 1004, please contact technical support',
			];
        }
        
        $this->privateKey = openssl_pkey_get_private($keyContent);
        if ($this->privateKey === false) {
            return [
				'error'=>1,
				'message'=>'Server error 1005, please contact technical support',
			];
        }
    }
    
    /**
     * Дешифровка данных, зашифрованных с RSA-OAEP SHA-256
     * @param string $encryptedBase64 Данные в base64url формате
     * @return string|false
     */
    public function decryptOAEP($encryptedBase64) {
        try {
            // Конвертируем base64url в обычный base64
            $base64 = strtr($encryptedBase64, '-_', '+/');
            
            // Декодируем из base64
            $encryptedData = base64_decode($base64, true);
            if ($encryptedData === false) {
                return [
					'error'=>1,
					'message'=>'Server error 1006, please contact technical support',
				];
            }
            
            // Для RSA-OAEP с SHA-256 нужно использовать специальный подход
            // PHP не имеет встроенной поддержки OAEP с SHA-256, поэтому используем openssl_private_decrypt с правильным паддингом
            
            $decrypted = '';
            
            // В PHP 8.0+ есть константа OPENSSL_PKCS1_OAEP_PADDING
            // Но для SHA-256 нужен дополнительный параметр
            
            // Проверяем версию PHP и используем доступные методы
            if (defined('OPENSSL_PKCS1_OAEP_PADDING')) {
                // Используем OAEP паддинг
                $success = openssl_private_decrypt(
                    $encryptedData, 
                    $decrypted, 
                    $this->privateKey, 
                    OPENSSL_PKCS1_OAEP_PADDING
                );
                
                if ($success) {
					return [
						'error'=>0,
						'data'=>$decrypted,
					];
                }
            }
            
            // Если не получилось, пробуем альтернативный метод через OpenSSL CLI
            // Создаем временный файл с зашифрованными данными
            $tempFile = tempnam(sys_get_temp_dir(), 'rsa_');
            file_put_contents($tempFile, $encryptedData);
            
            $privateKeyFile = tempnam(sys_get_temp_dir(), 'key_');
            file_put_contents($privateKeyFile, $this->getPrivateKeyString());
            
            // Используем openssl командой с правильными параметрами
            $command = sprintf(
                'openssl pkeyutl -decrypt -in %s -out %s -inkey %s -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 2>&1',
                escapeshellarg($tempFile),
                escapeshellarg($tempFile . '.dec'),
                escapeshellarg($privateKeyFile)
            );
            
            exec($command, $output, $returnCode);
            
            $result = false;
            if ($returnCode === 0 && file_exists($tempFile . '.dec')) {
                $result = file_get_contents($tempFile . '.dec');
            }
            
            // Очищаем временные файлы
            @unlink($tempFile);
            @unlink($tempFile . '.dec');
            @unlink($privateKeyFile);
            
            if ($result !== false) {
				return [
					'error'=>0,
					'data'=>$result,
				];
            }
            
            return [
				'error'=>1,
				'message'=>'Server error 1007, please contact technical support',
			];
            
        } catch (Exception $e) {
            error_log("RSA decryption error: " . $e->getMessage());
			return [
				'error'=>1,
				'message'=>'Server error 1008, please contact technical support',
			];
        }
    }
    
    /**
     * Альтернативный метод дешифровки через phpseclib
     * Требует установки: composer require phpseclib/phpseclib:~3.0
     */
    public function decryptOAEPWithPhpSecLib($encryptedBase64) {
        // Конвертируем base64url в обычный base64
        $base64 = strtr($encryptedBase64, '-_', '+/');
        $encryptedData = base64_decode($base64, true);
        
        // Используем phpseclib для RSA OAEP SHA256
        // Требуется установка: composer require phpseclib/phpseclib:~3.0
        try {
            if (class_exists('phpseclib3\Crypt\PublicKeyLoader')) {
                $rsa = \phpseclib3\Crypt\PublicKeyLoader::load($this->getPrivateKeyString())
                    ->withHash('sha256')
                    ->withMGFHash('sha256');
                
                $decrypted = $rsa->decrypt($encryptedData);
				return [
					'error'=>0,
					'data'=>$decrypted,
				];
            }
        } catch (\Exception $e) {
            error_log("phpseclib decryption error: " . $e->getMessage());
        }
        
        return false;
    }
    
    private function getPrivateKeyString() {
        // Получаем строковое представление ключа
        $keyContent = file_get_contents($this->privateKeyPath);
        return $keyContent;
    }
    
    public function __destruct() {
        if ($this->privateKey) {
            openssl_free_key($this->privateKey);
        }
    }
}
?>