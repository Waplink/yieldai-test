<?php
class WalletValidator {
    
    /**
     * Валидация адреса Solana
     * @param string $address Адрес кошелька Solana
     * @return bool
     */
    public static function validateSolanaAddress($address) {
        if (empty($address)) {
            return false;
        }
        
        // Solana адреса:
        // - Длина: 32-44 символа (обычно 43-44)
        // - Base58 формат (алфавит: 1-9A-HJ-NP-Za-km-z)
        // - Начинается с определенных символов в зависимости от типа
        
        // Проверка длины (стандартный Solana адрес - 32-44 символа)
        $length = strlen($address);
        if ($length < 32 || $length > 44) {
            return false;
        }
        
        // Проверка на допустимые символы Base58 (без 0, O, I, l)
        if (!preg_match('/^[1-9A-HJ-NP-Za-km-z]+$/', $address)) {
            return false;
        }
        
        // Дополнительная проверка: адрес не должен начинаться с 0
        if ($address[0] === '0') {
            return false;
        }
        
        return true;
    }
    
    /**
     * Валидация адреса Aptos
     * @param string $address Адрес кошелька Aptos
     * @return bool
     */
    public static function validateAptosAddress($address) {
        if (empty($address)) {
            return false;
        }
        
        // Aptos адреса:
        // - Hex формат (0x + 64 hex символа) или просто 64 hex символа
        // - Длина: 64 или 66 символов (с префиксом 0x)
        // - Допустимы символы: 0-9, a-f, A-F
        
        // Убираем префикс 0x если есть
        $cleanAddress = strtolower($address);
        if (strpos($cleanAddress, '0x') === 0) {
            $cleanAddress = substr($cleanAddress, 2);
        }
        
        // Проверка длины (должно быть 64 символа)
        if (strlen($cleanAddress) !== 64) {
            return false;
        }
        
        // Проверка на hex символы
        if (!ctype_xdigit($cleanAddress)) {
            return false;
        }
        
        return true;
    }
    
    /**
     * Валидация адреса Aptos с учетом особых случаев
     * @param string $address Адрес кошелька Aptos
     * @return bool
     */
    public static function validateAptosAddressStrict($address) {
        if (!self::validateAptosAddress($address)) {
            return false;
        }
        
        // Приводим к нижнему регистру для единообразия
        $cleanAddress = strtolower($address);
        if (strpos($cleanAddress, '0x') === 0) {
            $cleanAddress = substr($cleanAddress, 2);
        }
        
        // Aptos адреса обычно не начинаются с 0000...
        // Но это не строгое правило, можно пропустить если нужно
        if (substr($cleanAddress, 0, 4) === '0000') {
            // Это может быть специальный адрес (например, ресурсный)
            // Возвращаем true, но можно залогировать
            error_log("Warning: Aptos address starts with zeros: " . $address);
        }
        
        return true;
    }
    
    /**
     * Проверка на zero address
     * @param string $address Адрес кошелька
     * @param string $type 'solana' или 'aptos'
     * @return bool
     */
    public static function isZeroAddress($address, $type) {
        if ($type === 'solana') {
            // Solana zero address (редко используется)
            return $address === '11111111111111111111111111111111';
        } elseif ($type === 'aptos') {
            // Aptos zero address
            $cleanAddress = strtolower($address);
            if (strpos($cleanAddress, '0x') === 0) {
                $cleanAddress = substr($cleanAddress, 2);
            }
            return $cleanAddress === str_repeat('0', 64);
        }
        return false;
    }
}
?>