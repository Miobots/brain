

export interface RequestQueue {
  /**
   * @param providerKey  
   *                     
   * @param job         
   */
  enqueue<T>(providerKey: string, job: () => Promise<T>): Promise<T>;
 
  /** For a future /health endpoint and for tests. */
  stats(providerKey: string): { active: number; waiting: number };
}
 