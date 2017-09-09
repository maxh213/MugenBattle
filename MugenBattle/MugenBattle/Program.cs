using System.Diagnostics;
using System.AppDomain;

namespace MugenBattle
{
    class Program
    {
        static void Main(string[] args)
        {
            Process proc = new Process();
            proc.StartInfo.FileName = AppDomain.CurrentDomain.BaseDirectory + sFileName + ".bat";
            proc.StartInfo.WindowStyle = ProcessWindowStyle.Hidden;
            proc.Start();
            proc.WaitForExit();
        }
    }
}