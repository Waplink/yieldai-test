<?php
require_once 'baseFunction.php';

/**
 * class TGCron
 */
class TGCron
{
	private $helpers;
	
	/**
	 * construct
	 */
	function __construct() {
		$this->helpers = new baseFunction();
	}
	
	/**
	 * getData($data=[])
	 */
	public function getData($address='')
	{
		
		$users = $this->getTGUsers(1);
		if (empty($users) || !is_array($users)) {
			return false;
		}
		
		$path = dirname(__FILE__).'/WalletValidator.php';
		if (!file_exists($path)) {
			return false;
		}
				
		require_once($path);
		if (!class_exists('WalletValidator')) {
			return false;		
		}	

		foreach ($users as $value) {
			
			if (empty($value['address_aptos'])) {
				continue;
			}
			
			$address_aptos = trim($value['address_aptos']);
			
			if (!WalletValidator::validateAptosAddress($address_aptos)) {
				continue;
			}
			
			if (WalletValidator::isZeroAddress($address_aptos, 'aptos')) {
				continue;		
			}

			$value['balance'] = $this->helpers->getBalance($address_aptos);
			$value['protocols'] = $this->helpers->getProtocols($address_aptos);

			$count = $this->getUserdataCount($value['id']);
			if ($count<$this->helpers->countRows) {
				
				if ($this->createUserPortfolio($value)) {
	
				}
				
			} else {

				$update_row = $this->getUserdataOverdue($value['id']);
				if (!empty($update_row)) {
					
					if ($this->updateUserPortfolio($update_row, $value)) {
					
					}
				}			
			}
		}	
	}
	
	/**
	 * updateUserPortfolio($update=[]) 
	 */
	private function updateUserPortfolio($id=0, $update=[]) 
	{
		$new_update = [
			':id_user' => 0,
			':datetime' => time(),
			':balance' => '',
			':protocols' => '',
			':id' => 0,
		];

		if (empty($id) || empty($update)) {
			return false;
		}
		
		$new_update[':id'] = $id;

		if (!empty($update['id'])) {
			$new_update[':id_user'] = $update['id'];
		}

		if (!empty($update['balance'])) {
			$new_update[':balance'] = json_encode($update['balance']);
		}

		if (!empty($update['protocols'])) {
			$new_update[':protocols'] = json_encode($update['protocols']);
		}

		$sql = '
			UPDATE `001_userdata`  
			SET 
				`id_user` = :id_user,
				`datetime` = :datetime,
				`balance` = :balance,
				`protocols` = :protocols

			WHERE `id_record` = :id
			AND deleted=0
		';

		$result = $this->helpers->queryParams($sql, $new_update);
		if (!empty($result) && !empty($result['completed'])) {
			return true;
		}

		return false;		
	}
	
	/**
	 * createUserPortfolio($update=[]) 
	 */
	private function createUserPortfolio($update=[]) 
	{
		if (empty($update)) {
			return false;
		}
		
		$sql = '
			INSERT INTO `001_userdata` 
			(`datetime`, `id_user`, `balance`, `protocols`) 
			VALUES 
			(:datetime, :id_user, :balance, :protocols)
		';

		$id_user = 0;
		if (!empty($update['id'])) {
			$id_user = $update['id'];
		}

		$balance = '';
		if (!empty($update['balance'])) {
			$balance = json_encode($update['balance']);
		}
		
		$protocols = '';
		if (!empty($update['protocols'])) {
			$protocols = json_encode($update['protocols']);
		}

		$params = [
			':datetime' => time(),
			':id_user' => $id_user,
			':balance' => $balance,
			':protocols' => $protocols,
		];

		$result = $this->helpers->queryParams($sql, $params);
		if (!empty($result) && !empty($result['completed'])) {
			return true;
		}

		return false;
	}
	
	/**
	 * getUserdataOverdue($id_user=0) 
	 */
	private function getUserdataOverdue($id_user=0) 
	{
		$sql = '
			SELECT
				`id_record`
			FROM `001_userdata`
			WHERE `deleted` = 0
			AND `id_user` = :id_user
			ORDER BY `datetime` ASC
			LIMIT 1
		';

		$params = [
			':id_user' => $id_user,
		];
		
		$result = $this->helpers->queryParams($sql, $params, 'fetchAll');
		if (!empty($result) && !empty($result['completed']) && is_array($result['completed']) && !empty($result['completed'][0]) && isset($result['completed'][0]['id_record'])) {
			return $result['completed'][0]['id_record'];
		}
	
		return false;
	}
	
	/**
	 * getUserdataCount($id_user=0) 
	 */
	private function getUserdataCount($id_user=0) 
	{
		$sql = '
			SELECT
				COUNT(`id_record`) AS `count`
			FROM `001_userdata`
			WHERE `deleted` = 0
			AND `id_user` = :id_user
		';

		$params = [
			':id_user' => $id_user,
		];

		$result = $this->helpers->queryParams($sql, $params, 'fetchAll');
		if (!empty($result) && !empty($result['completed']) && is_array($result['completed']) && !empty($result['completed'][0]) && isset($result['completed'][0]['count'])) {
			return $result['completed'][0]['count'];
		}
	
		return false;	
	}
	
	/**
	 * getTGUser($token='')
	 */
	private function getTGUsers($type=0) 
	{
		$sql = '
			SELECT
				`id`,
				`from_id`,
				`address_aptos`,
				`address_solana`,
				`id_bot`,
				`from_first_name`,
				`from_last_name`,
				`from_username`
			FROM `001_subscribe`
			WHERE `deleted` = 0
			AND `from_id` <> 0
		';
		
		if ($type==1) {
			$sql .= '
				AND `address_aptos` <> ""
			';
		} else if ($type==2) {
			$sql .= '
				AND `address_solana` <> ""
			';
		}
		
		$params = [];

		$result = $this->helpers->queryParams($sql, $params, 'fetchAll');
		if (!empty($result) && !empty($result['completed']) && is_array($result['completed'])) {
			return $result['completed'];
		}
	
		return false;	
	}

	/**
	 * class($className=__CLASS__)
	 */ 
	public static function tg($className=__CLASS__)
	{
		return new $className;
	}
}